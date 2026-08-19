package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/kandev/kandev/pkg/pluginsdk"
	"github.com/stretchr/testify/require"
)

func newAgentTagTestPlugin() (*tagsPlugin, *fakeHost) {
	host := &fakeHost{}
	p := &tagsPlugin{}
	p.SetHost(host)
	return p, host
}

func agentToolReq(name string, args map[string]any) *pluginsdk.AgentToolRequest {
	return &pluginsdk.AgentToolRequest{
		Name:      name,
		Arguments: args,
		Context: pluginsdk.AgentToolContext{
			TaskID:      "task-1",
			SessionID:   "session-1",
			WorkspaceID: "ws-1",
			Surface:     "kanban-task",
		},
	}
}

func resultTags(t *testing.T, result *pluginsdk.AgentToolResult) []string {
	t.Helper()
	raw, ok := result.StructuredContent["tags"].([]any)
	require.True(t, ok, "StructuredContent.tags should be an array")
	out := make([]string, len(raw))
	for i, tag := range raw {
		out[i], ok = tag.(string)
		require.True(t, ok, "tag %d should be a string", i)
	}
	return out
}

func storedAgentDoc(t *testing.T, host *fakeHost, workspaceID string) agentTagDoc {
	t.Helper()
	raw, found, err := host.GetState(context.Background(), "workspace", workspaceID, agentTagsStateKey)
	require.NoError(t, err)
	require.True(t, found)
	doc, err := decodeAgentTagDoc(raw)
	require.NoError(t, err)
	return doc
}

func storedAgentRawJSON(t *testing.T, host *fakeHost, workspaceID string) string {
	t.Helper()
	raw, _, err := host.GetState(context.Background(), "workspace", workspaceID, agentTagsStateKey)
	require.NoError(t, err)
	b, err := json.Marshal(raw)
	require.NoError(t, err)
	return string(b)
}

func TestInvokeAgentToolAddTagStoresAndReturnsStructuredTags(t *testing.T) {
	p, host := newAgentTagTestPlugin()

	result, err := p.InvokeAgentTool(context.Background(), agentToolReq("add_tag", map[string]any{"tag": "blocked"}))
	require.NoError(t, err)
	require.False(t, result.IsError)
	require.NotEmpty(t, result.Text)
	require.Equal(t, []string{"blocked"}, resultTags(t, result))

	doc := storedAgentDoc(t, host, "ws-1")
	require.Len(t, doc.Tasks["task-1"], 1)
	entry := doc.Tasks["task-1"][0]
	require.Equal(t, "blocked", entry.Tag)
	require.Equal(t, "", entry.Note)
	require.Equal(t, "session-1", entry.SessionID)
	require.NotEmpty(t, entry.UpdatedAt)
}

func TestInvokeAgentToolRejectsInvalidTagWithoutMutation(t *testing.T) {
	p, host := newAgentTagTestPlugin()
	_, err := p.InvokeAgentTool(context.Background(), agentToolReq("add_tag", map[string]any{"tag": "blocked"}))
	require.NoError(t, err)
	before := storedAgentRawJSON(t, host, "ws-1")

	result, err := p.InvokeAgentTool(context.Background(), agentToolReq("add_tag", map[string]any{"tag": "nonsense"}))
	require.NoError(t, err)
	require.True(t, result.IsError)
	for _, valid := range []string{"blocked", "needs-input", "needs-review", "failed", "obsolete", "abandoned"} {
		require.Contains(t, result.Text, valid)
	}
	require.Equal(t, before, storedAgentRawJSON(t, host, "ws-1"))
}

func TestInvokeAgentToolAddTagIsIdempotentAndUpdatesNote(t *testing.T) {
	p, host := newAgentTagTestPlugin()

	_, err := p.InvokeAgentTool(context.Background(), agentToolReq("add_tag", map[string]any{"tag": "blocked", "note": "first"}))
	require.NoError(t, err)
	first := storedAgentDoc(t, host, "ws-1").Tasks["task-1"][0]
	time.Sleep(time.Millisecond)

	result, err := p.InvokeAgentTool(context.Background(), agentToolReq("add_tag", map[string]any{"tag": "blocked", "note": "second"}))
	require.NoError(t, err)
	require.False(t, result.IsError)
	require.Equal(t, []string{"blocked"}, resultTags(t, result))

	entries := storedAgentDoc(t, host, "ws-1").Tasks["task-1"]
	require.Len(t, entries, 1)
	require.Equal(t, "second", entries[0].Note)
	require.Greater(t, entries[0].UpdatedAt, first.UpdatedAt)
}

func TestInvokeAgentToolRemoveTagIsIdempotentAndDeletesEmptyTask(t *testing.T) {
	p, host := newAgentTagTestPlugin()
	result, err := p.InvokeAgentTool(context.Background(), agentToolReq("remove_tag", map[string]any{"tag": "blocked"}))
	require.NoError(t, err)
	require.False(t, result.IsError)
	require.Equal(t, []string{}, resultTags(t, result))

	_, err = p.InvokeAgentTool(context.Background(), agentToolReq("add_tag", map[string]any{"tag": "blocked"}))
	require.NoError(t, err)
	result, err = p.InvokeAgentTool(context.Background(), agentToolReq("remove_tag", map[string]any{"tag": "blocked"}))
	require.NoError(t, err)
	require.False(t, result.IsError)
	require.Equal(t, []string{}, resultTags(t, result))
	require.NotContains(t, storedAgentDoc(t, host, "ws-1").Tasks, "task-1")
}

func TestInvokeAgentToolListTagsSortsAndDoesNotMutate(t *testing.T) {
	p, host := newAgentTagTestPlugin()
	doc := newAgentTagDoc()
	doc.Tasks["task-1"] = []tagEntry{
		{Tag: "failed", UpdatedAt: "2026-08-19T00:00:02Z"},
		{Tag: "blocked", UpdatedAt: "2026-08-19T00:00:01Z"},
	}
	raw, err := encodeAgentTagDoc(doc)
	require.NoError(t, err)
	require.NoError(t, host.SetState(context.Background(), "workspace", "ws-1", agentTagsStateKey, raw))
	before := storedAgentRawJSON(t, host, "ws-1")

	result, err := p.InvokeAgentTool(context.Background(), agentToolReq("list_tags", nil))
	require.NoError(t, err)
	require.False(t, result.IsError)
	require.Equal(t, []string{"blocked", "failed"}, resultTags(t, result))
	require.Equal(t, before, storedAgentRawJSON(t, host, "ws-1"))
}

func TestInvokeAgentToolRequiresTaskAndWorkspaceContextWithoutMutation(t *testing.T) {
	p, host := newAgentTagTestPlugin()
	for name, mutate := range map[string]func(*pluginsdk.AgentToolRequest){
		"task_id":      func(req *pluginsdk.AgentToolRequest) { req.Context.TaskID = "" },
		"workspace_id": func(req *pluginsdk.AgentToolRequest) { req.Context.WorkspaceID = "" },
	} {
		t.Run(name, func(t *testing.T) {
			req := agentToolReq("add_tag", map[string]any{"tag": "blocked"})
			mutate(req)
			result, err := p.InvokeAgentTool(context.Background(), req)
			require.NoError(t, err)
			require.True(t, result.IsError)
			require.Contains(t, result.Text, name)
		})
	}
	require.Nil(t, host.state, "missing context must not create stored state")
}

func TestInvokeAgentToolTruncatesLongNoteByRune(t *testing.T) {
	p, host := newAgentTagTestPlugin()
	longNote := ""
	for i := 0; i < 205; i++ {
		longNote += "界"
	}

	result, err := p.InvokeAgentTool(context.Background(), agentToolReq("add_tag", map[string]any{"tag": "blocked", "note": longNote}))
	require.NoError(t, err)
	require.False(t, result.IsError)
	note := storedAgentDoc(t, host, "ws-1").Tasks["task-1"][0].Note
	require.Len(t, []rune(note), 200)
}

func TestMutateWorkspaceDocCapsTasksByEvictingOldestUpdatedAt(t *testing.T) {
	p, host := newAgentTagTestPlugin()
	doc := newAgentTagDoc()
	for i := 0; i < agentTagTaskCap; i++ {
		taskID := fmt.Sprintf("task-%03d", i)
		doc.Tasks[taskID] = []tagEntry{{Tag: "blocked", UpdatedAt: fmt.Sprintf("2026-08-19T00:00:%02dZ", i)}}
	}
	raw, err := encodeAgentTagDoc(doc)
	require.NoError(t, err)
	require.NoError(t, host.SetState(context.Background(), "workspace", "ws-1", agentTagsStateKey, raw))

	req := agentToolReq("add_tag", map[string]any{"tag": "blocked"})
	req.Context.TaskID = "task-new"
	result, err := p.InvokeAgentTool(context.Background(), req)
	require.NoError(t, err)
	require.False(t, result.IsError)

	stored := storedAgentDoc(t, host, "ws-1")
	require.Len(t, stored.Tasks, agentTagTaskCap)
	require.NotContains(t, stored.Tasks, "task-000")
	require.Contains(t, stored.Tasks, "task-new")
}

func TestInvokeAgentToolConcurrentDistinctTasksDoNotLoseUpdates(t *testing.T) {
	p, host := newAgentTagTestPlugin()
	var wg sync.WaitGroup
	errs := make(chan error, 50)
	for i := 0; i < 50; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			req := agentToolReq("add_tag", map[string]any{"tag": "blocked"})
			req.Context.TaskID = fmt.Sprintf("task-%02d", i)
			result, err := p.InvokeAgentTool(context.Background(), req)
			if err != nil {
				errs <- err
				return
			}
			if result.IsError {
				errs <- errors.New(result.Text)
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		require.NoError(t, err)
	}
	require.Len(t, storedAgentDoc(t, host, "ws-1").Tasks, 50)
}
