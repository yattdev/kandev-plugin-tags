package main

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"

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
	return &pluginsdk.AgentToolRequest{Name: name, Arguments: args, Context: pluginsdk.AgentToolContext{TaskID: "task-1", SessionID: "session-1", WorkspaceID: "ws-1", Surface: "kanban-task"}}
}
func storedTagDoc(t *testing.T, host *fakeHost, workspaceID string) tagDoc {
	t.Helper()
	raw, found, err := host.GetState(context.Background(), "workspace", workspaceID, tagStateKey)
	require.NoError(t, err)
	require.True(t, found)
	doc, err := decodeTagDoc(raw)
	require.NoError(t, err)
	return doc
}
func agentCreate(t *testing.T, p *tagsPlugin, name string) string {
	t.Helper()
	result, err := p.InvokeAgentTool(context.Background(), agentToolReq("create_tag", map[string]any{"name": name, "color": "#2563eb"}))
	require.NoError(t, err)
	require.False(t, result.IsError, result.Text)
	catalog := result.StructuredContent["catalog"].([]any)
	for _, raw := range catalog {
		tag := raw.(map[string]any)
		if tag["name"] == name {
			return tag["id"].(string)
		}
	}
	t.Fatal("created tag missing from tool result")
	return ""
}

func TestAgentCanCreateApplyEditAndDeleteOwnSharedTag(t *testing.T) {
	p, host := newAgentTagTestPlugin()
	id := agentCreate(t, p, "Waiting on API")

	result, err := p.InvokeAgentTool(context.Background(), agentToolReq("add_tag", map[string]any{"tag_id": id, "note": "credentials requested"}))
	require.NoError(t, err)
	require.False(t, result.IsError)
	doc := storedTagDoc(t, host, "ws-1")
	require.Equal(t, ownerAgent, doc.Tags[0].Owner)
	require.Equal(t, true, doc.Tasks["task-1"][0].Agent)
	require.Equal(t, "credentials requested", doc.Tasks["task-1"][0].Note)

	result, err = p.InvokeAgentTool(context.Background(), agentToolReq("update_tag", map[string]any{"tag_id": id, "name": "Waiting for API", "color": "#f59e0b"}))
	require.NoError(t, err)
	require.False(t, result.IsError)
	doc = storedTagDoc(t, host, "ws-1")
	require.Equal(t, "Waiting for API", doc.Tags[0].Name)
	require.Equal(t, "#f59e0b", doc.Tags[0].Color)

	result, err = p.InvokeAgentTool(context.Background(), agentToolReq("delete_tag", map[string]any{"tag_id": id}))
	require.NoError(t, err)
	require.False(t, result.IsError)
	doc = storedTagDoc(t, host, "ws-1")
	require.Empty(t, doc.Tags)
	require.Empty(t, doc.Tasks)
}

func TestAgentCannotManageHumanOwnedTagAndHumanApplicationSurvivesAgentRemoval(t *testing.T) {
	p, host := newAgentTagTestPlugin()
	_, err := p.HandleAction(context.Background(), actionReq("tag-create", []byte(`{"name":"Human priority","color":"#ef4444"}`)))
	require.NoError(t, err)
	doc := storedTagDoc(t, host, "ws-1")
	humanID := doc.Tags[0].ID

	result, err := p.InvokeAgentTool(context.Background(), agentToolReq("add_tag", map[string]any{"tag_id": humanID}))
	require.NoError(t, err)
	require.True(t, result.IsError)
	require.Contains(t, result.Text, "agent-created")

	agentID := agentCreate(t, p, "Agent marker")
	_, err = p.InvokeAgentTool(context.Background(), agentToolReq("add_tag", map[string]any{"tag_id": agentID}))
	require.NoError(t, err)
	_, err = p.HandleAction(context.Background(), actionReq("task-tag-add", []byte(`{"tagId":"`+agentID+`"}`)))
	require.NoError(t, err)
	_, err = p.InvokeAgentTool(context.Background(), agentToolReq("remove_tag", map[string]any{"tag_id": agentID}))
	require.NoError(t, err)
	doc = storedTagDoc(t, host, "ws-1")
	entry := doc.Tasks["task-1"][0]
	require.False(t, entry.Agent)
	require.True(t, entry.Human)
}

func TestAgentToolTruncatesNoteAndValidatesContext(t *testing.T) {
	p, host := newAgentTagTestPlugin()
	id := agentCreate(t, p, "Long note")
	long := strings.Repeat("界", 205)
	result, err := p.InvokeAgentTool(context.Background(), agentToolReq("add_tag", map[string]any{"tag_id": id, "note": long}))
	require.NoError(t, err)
	require.False(t, result.IsError)
	require.Len(t, []rune(storedTagDoc(t, host, "ws-1").Tasks["task-1"][0].Note), maxTagNoteRunes)

	req := agentToolReq("list_tags", nil)
	req.Context.WorkspaceID = ""
	result, err = p.InvokeAgentTool(context.Background(), req)
	require.NoError(t, err)
	require.True(t, result.IsError)
	require.Contains(t, result.Text, "workspace_id")
}

func TestLegacyAgentStatusDocumentMigratesOnNextWrite(t *testing.T) {
	p, host := newAgentTagTestPlugin()
	legacy := map[string]any{"version": 1, "tasks": map[string]any{"task-1": []any{map[string]any{"tag": "blocked", "note": "waiting", "updated_at": "2026-01-01T00:00:00Z"}}}}
	require.NoError(t, host.SetState(context.Background(), "workspace", "ws-1", tagStateKey, legacy))
	result, err := p.InvokeAgentTool(context.Background(), agentToolReq("list_tags", nil))
	require.NoError(t, err)
	require.False(t, result.IsError)
	require.Equal(t, "Blocked", result.StructuredContent["tags"].([]any)[0].(map[string]any)["name"])
	_, err = p.InvokeAgentTool(context.Background(), agentToolReq("create_tag", map[string]any{"name": "new"}))
	require.NoError(t, err)
	doc := storedTagDoc(t, host, "ws-1")
	require.Equal(t, 2, doc.Version)
	require.Len(t, doc.Tags, 2)
}

func TestMutationsAreSerializedAndCapTaskDocuments(t *testing.T) {
	p, host := newAgentTagTestPlugin()
	id := agentCreate(t, p, "Concurrent")
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			req := agentToolReq("add_tag", map[string]any{"tag_id": id})
			req.Context.TaskID = fmt.Sprintf("task-%02d", i)
			_, err := p.InvokeAgentTool(context.Background(), req)
			require.NoError(t, err)
		}(i)
	}
	wg.Wait()
	require.Len(t, storedTagDoc(t, host, "ws-1").Tasks, 50)

	doc := newTagDoc()
	doc.Tags = []sharedTag{{ID: id, Name: "Concurrent", Color: defaultTagColor, Owner: ownerAgent}}
	for i := 0; i < tagTaskCap; i++ {
		doc.Tasks[fmt.Sprintf("old-%03d", i)] = []taskTag{{TagID: id, Agent: true, UpdatedAt: fmt.Sprintf("2026-01-01T00:00:%02dZ", i)}}
	}
	raw, err := encodeTagDoc(doc)
	require.NoError(t, err)
	require.NoError(t, host.SetState(context.Background(), "workspace", "ws-cap", tagStateKey, raw))
	req := agentToolReq("add_tag", map[string]any{"tag_id": id})
	req.Context.WorkspaceID = "ws-cap"
	req.Context.TaskID = "new"
	_, err = p.InvokeAgentTool(context.Background(), req)
	require.NoError(t, err)
	capDoc := storedTagDoc(t, host, "ws-cap")
	require.Len(t, capDoc.Tasks, tagTaskCap)
	require.NotContains(t, capDoc.Tasks, "old-000")
	require.Contains(t, capDoc.Tasks, "new")
}
