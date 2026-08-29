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

// The optional task_id argument lets an agent (typically a coordinator) tag a
// card other than its own. Workspace scoping is unchanged: the target is a key
// inside the caller's own workspace document.
func TestAgentToolsTargetAnotherTaskWhenTaskIDSupplied(t *testing.T) {
	p, host := newAgentTagTestPlugin()
	id := agentCreate(t, p, "Needs review")

	result, err := p.InvokeAgentTool(context.Background(), agentToolReq("add_tag", map[string]any{"tag_id": id, "task_id": "task-other", "note": "queued behind #42"}))
	require.NoError(t, err)
	require.False(t, result.IsError, result.Text)

	doc := storedTagDoc(t, host, "ws-1")
	require.NotContains(t, doc.Tasks, "task-1", "caller's own task must be untouched")
	require.Len(t, doc.Tasks["task-other"], 1)
	require.True(t, doc.Tasks["task-other"][0].Agent)
	require.Equal(t, "queued behind #42", doc.Tasks["task-other"][0].Note)
	require.Equal(t, "session-1", doc.Tasks["task-other"][0].SessionID)

	// The result view reflects the target task, not the caller's.
	require.Len(t, result.StructuredContent["tags"].([]any), 1)
	require.Equal(t, "Needs review", result.StructuredContent["tags"].([]any)[0].(map[string]any)["name"])

	listed, err := p.InvokeAgentTool(context.Background(), agentToolReq("list_tags", map[string]any{"task_id": "task-other"}))
	require.NoError(t, err)
	require.False(t, listed.IsError, listed.Text)
	require.Len(t, listed.StructuredContent["tags"].([]any), 1)

	removed, err := p.InvokeAgentTool(context.Background(), agentToolReq("remove_tag", map[string]any{"tag_id": id, "task_id": "task-other"}))
	require.NoError(t, err)
	require.False(t, removed.IsError, removed.Text)
	require.NotContains(t, storedTagDoc(t, host, "ws-1").Tasks, "task-other")
	require.Empty(t, removed.StructuredContent["tags"].([]any))
}

// The compatibility guarantee: omitting task_id -- or passing it blank -- must
// behave exactly as before, acting on the calling agent's own task.
func TestAgentToolsFallBackToCallerTaskWhenTaskIDOmitted(t *testing.T) {
	p, host := newAgentTagTestPlugin()
	id := agentCreate(t, p, "Own card")

	_, err := p.InvokeAgentTool(context.Background(), agentToolReq("add_tag", map[string]any{"tag_id": id}))
	require.NoError(t, err)
	require.Len(t, storedTagDoc(t, host, "ws-1").Tasks["task-1"], 1)

	// A blank or whitespace-only argument is treated as absent rather than
	// creating an entry under an empty task key.
	_, err = p.InvokeAgentTool(context.Background(), agentToolReq("remove_tag", map[string]any{"tag_id": id, "task_id": "   "}))
	require.NoError(t, err)
	doc := storedTagDoc(t, host, "ws-1")
	require.NotContains(t, doc.Tasks, "task-1")
	require.NotContains(t, doc.Tasks, "")
	require.NotContains(t, doc.Tasks, "   ")

	blank, err := p.InvokeAgentTool(context.Background(), agentToolReq("add_tag", map[string]any{"tag_id": id, "task_id": ""}))
	require.NoError(t, err)
	require.False(t, blank.IsError, blank.Text)
	require.Len(t, storedTagDoc(t, host, "ws-1").Tasks["task-1"], 1)
}

// A task_id naming a card with no existing entries is accepted (decision A):
// the plugin has no platform client to validate against, and an inert entry is
// contained by workspace scoping and reaped by the existing eviction path.
func TestAgentToolsAcceptTargetTaskWithNoExistingEntries(t *testing.T) {
	p, host := newAgentTagTestPlugin()
	id := agentCreate(t, p, "Fresh")

	listed, err := p.InvokeAgentTool(context.Background(), agentToolReq("list_tags", map[string]any{"task_id": "never-seen"}))
	require.NoError(t, err)
	require.False(t, listed.IsError, listed.Text)
	require.Empty(t, listed.StructuredContent["tags"].([]any))
	require.Len(t, listed.StructuredContent["catalog"].([]any), 1)

	// Removing from a task that has no entries is a no-op, not an error.
	removed, err := p.InvokeAgentTool(context.Background(), agentToolReq("remove_tag", map[string]any{"tag_id": id, "task_id": "never-seen"}))
	require.NoError(t, err)
	require.False(t, removed.IsError, removed.Text)
	require.NotContains(t, storedTagDoc(t, host, "ws-1").Tasks, "never-seen")

	added, err := p.InvokeAgentTool(context.Background(), agentToolReq("add_tag", map[string]any{"tag_id": id, "task_id": "never-seen"}))
	require.NoError(t, err)
	require.False(t, added.IsError, added.Text)
	require.Len(t, storedTagDoc(t, host, "ws-1").Tasks["never-seen"], 1)
}

// Targeting another task must not become a way around agent ownership, and a
// human's application on the target task must survive an agent removal.
func TestAgentToolsPreserveOwnershipOnTargetedTask(t *testing.T) {
	p, host := newAgentTagTestPlugin()
	_, err := p.HandleAction(context.Background(), actionReq("tag-create", []byte(`{"name":"Human only","color":"#ef4444"}`)))
	require.NoError(t, err)
	humanID := storedTagDoc(t, host, "ws-1").Tags[0].ID

	result, err := p.InvokeAgentTool(context.Background(), agentToolReq("add_tag", map[string]any{"tag_id": humanID, "task_id": "task-other"}))
	require.NoError(t, err)
	require.True(t, result.IsError)
	require.Contains(t, result.Text, "agent-created")
	require.NotContains(t, storedTagDoc(t, host, "ws-1").Tasks, "task-other")

	// A human application on the target task, plus an agent application of the
	// same tag: removing the agent's leaves the human's intact.
	agentID := agentCreate(t, p, "Shared marker")
	_, err = p.InvokeAgentTool(context.Background(), agentToolReq("add_tag", map[string]any{"tag_id": agentID, "task_id": "task-other"}))
	require.NoError(t, err)
	doc := storedTagDoc(t, host, "ws-1")
	doc.Tasks["task-other"][0].Human = true
	raw, err := encodeTagDoc(doc)
	require.NoError(t, err)
	require.NoError(t, host.SetState(context.Background(), "workspace", "ws-1", tagStateKey, raw))

	_, err = p.InvokeAgentTool(context.Background(), agentToolReq("remove_tag", map[string]any{"tag_id": agentID, "task_id": "task-other"}))
	require.NoError(t, err)
	entry := storedTagDoc(t, host, "ws-1").Tasks["task-other"][0]
	require.False(t, entry.Agent, "agent application removed")
	require.True(t, entry.Human, "human application survives")
}

// Catalog tools stay workspace-scoped and unaffected by any task targeting
// (decision D1: no task_id on update_tag/delete_tag), and delete still
// cascades across every task including ones an agent targeted remotely.
func TestCatalogToolsIgnoreTaskTargetingAndStillCascade(t *testing.T) {
	p, host := newAgentTagTestPlugin()
	id := agentCreate(t, p, "Cascade")
	_, err := p.InvokeAgentTool(context.Background(), agentToolReq("add_tag", map[string]any{"tag_id": id, "task_id": "task-other"}))
	require.NoError(t, err)
	_, err = p.InvokeAgentTool(context.Background(), agentToolReq("add_tag", map[string]any{"tag_id": id}))
	require.NoError(t, err)
	require.Len(t, storedTagDoc(t, host, "ws-1").Tasks, 2)

	_, err = p.InvokeAgentTool(context.Background(), agentToolReq("delete_tag", map[string]any{"tag_id": id}))
	require.NoError(t, err)
	doc := storedTagDoc(t, host, "ws-1")
	require.Empty(t, doc.Tags)
	require.Empty(t, doc.Tasks)
}

// Workspace scoping is unchanged: a task_id only ever addresses a key inside
// the caller's own workspace document, never another workspace's.
func TestTargetedTagWritesStayInsideCallerWorkspace(t *testing.T) {
	p, host := newAgentTagTestPlugin()
	id := agentCreate(t, p, "Scoped")

	other := agentToolReq("add_tag", map[string]any{"tag_id": id, "task_id": "task-other"})
	other.Context.WorkspaceID = "ws-1"
	_, err := p.InvokeAgentTool(context.Background(), other)
	require.NoError(t, err)

	_, found, err := host.GetState(context.Background(), "workspace", "ws-2", tagStateKey)
	require.NoError(t, err)
	require.False(t, found, "no other workspace document may be created")
	require.Contains(t, storedTagDoc(t, host, "ws-1").Tasks, "task-other")
}

// Regression (QA): targetTaskID lets an agent name any task id, so a mistyped
// or invented target lands in doc.Tasks stamped with now(). Under a plain
// oldest-first cap that made the bogus entry the last survivor and evicted a
// real card's human-applied tags instead. Eviction must discard entries no
// human has curated first.
func TestCapEvictsUncuratedEntriesBeforeHumanAppliedOnes(t *testing.T) {
	p, host := newAgentTagTestPlugin()
	_, err := p.HandleAction(context.Background(), actionReq("tag-create", []byte(`{"name":"Human","color":"#ef4444"}`)))
	require.NoError(t, err)
	humanID := storedTagDoc(t, host, "ws-1").Tags[0].ID
	agentID := agentCreate(t, p, "Agent")

	doc := storedTagDoc(t, host, "ws-1")
	for i := 0; i < tagTaskCap; i++ {
		doc.Tasks[fmt.Sprintf("real-%03d", i)] = []taskTag{{TagID: humanID, Human: true, UpdatedAt: "2020-01-01T00:00:00Z"}}
	}
	raw, err := encodeTagDoc(doc)
	require.NoError(t, err)
	require.NoError(t, host.SetState(context.Background(), "workspace", "ws-1", tagStateKey, raw))

	// An agent targets a task id that does not exist.
	res, err := p.InvokeAgentTool(context.Background(), agentToolReq("add_tag", map[string]any{"tag_id": agentID, "task_id": "typo-does-not-exist"}))
	require.NoError(t, err)
	require.False(t, res.IsError, res.Text)

	after := storedTagDoc(t, host, "ws-1").Tasks
	require.Len(t, after, tagTaskCap)
	require.NotContains(t, after, "typo-does-not-exist", "the uncurated entry is evicted, not kept")
	for i := 0; i < tagTaskCap; i++ {
		require.Contains(t, after, fmt.Sprintf("real-%03d", i), "no human-applied entry may be displaced")
	}
}

// Eviction must not depend on Go's randomized map iteration order: identical
// input must always drop the same task, or a data-loss path becomes a coin flip.
func TestCapEvictionIsDeterministicOnTiedTimestamps(t *testing.T) {
	victims := map[string]int{}
	for run := 0; run < 8; run++ {
		p, host := newAgentTagTestPlugin()
		id := agentCreate(t, p, "Tied")
		doc := storedTagDoc(t, host, "ws-1")
		for i := 0; i < tagTaskCap; i++ {
			doc.Tasks[fmt.Sprintf("tied-%03d", i)] = []taskTag{{TagID: id, Agent: true, UpdatedAt: "2026-01-01T00:00:00Z"}}
		}
		raw, err := encodeTagDoc(doc)
		require.NoError(t, err)
		require.NoError(t, host.SetState(context.Background(), "workspace", "ws-1", tagStateKey, raw))

		_, err = p.InvokeAgentTool(context.Background(), agentToolReq("add_tag", map[string]any{"tag_id": id, "task_id": "newcomer"}))
		require.NoError(t, err)
		after := storedTagDoc(t, host, "ws-1").Tasks
		require.Len(t, after, tagTaskCap)
		for i := 0; i < tagTaskCap; i++ {
			if key := fmt.Sprintf("tied-%03d", i); !containsKey(after, key) {
				victims[key]++
			}
		}
	}
	require.Len(t, victims, 1, "the same task must be evicted every run, got %v", victims)
	require.Equal(t, 8, victims["tied-000"], "ties break on task id, lowest first")
}

func containsKey(m map[string][]taskTag, key string) bool {
	_, ok := m[key]
	return ok
}

// A task_id is an opaque map key, so hostile-looking values must be stored
// verbatim rather than interpreted, and must never produce a stray key. Padding
// is trimmed so an id copied from the board with surrounding whitespace still
// lands on the intended card.
func TestTargetTaskIDHandlesAdversarialValues(t *testing.T) {
	cases := []struct {
		label  string
		taskID any
		target string
	}{
		{"omitted", nil, "task-1"},
		{"explicit own task", "task-1", "task-1"},
		{"padded id is trimmed", "  task-2  ", "task-2"},
		{"unicode", "tâche-🚀-2", "tâche-🚀-2"},
		{"very long", strings.Repeat("x", 4096), strings.Repeat("x", 4096)},
		{"traversal shape is just a key", "../../other-ws/task", "../../other-ws/task"},
		{"json-ish is just a key", `{"a":1}`, `{"a":1}`},
	}
	for _, tc := range cases {
		t.Run(tc.label, func(t *testing.T) {
			p, host := newAgentTagTestPlugin()
			id := agentCreate(t, p, "Probe")
			args := map[string]any{"tag_id": id}
			if tc.taskID != nil {
				args["task_id"] = tc.taskID
			}
			res, err := p.InvokeAgentTool(context.Background(), agentToolReq("add_tag", args))
			require.NoError(t, err)
			require.False(t, res.IsError, res.Text)
			doc := storedTagDoc(t, host, "ws-1")
			require.Contains(t, doc.Tasks, tc.target)
			require.Len(t, doc.Tasks, 1, "exactly one task key written")
			require.NotContains(t, doc.Tasks, "", "never an empty task key")
		})
	}
}

// The manifest types task_id as a string and the host validates against it, so
// a non-string cannot arrive in practice. Should that ever change, the resolver
// must fall back to the caller's own task rather than panic or mis-target.
func TestTargetTaskIDIgnoresNonStringArgument(t *testing.T) {
	for _, bad := range []any{42, 3.14, true, nil, []any{"a"}, map[string]any{"k": "v"}} {
		p, host := newAgentTagTestPlugin()
		id := agentCreate(t, p, "Probe")
		res, err := p.InvokeAgentTool(context.Background(), agentToolReq("add_tag", map[string]any{"tag_id": id, "task_id": bad}))
		require.NoError(t, err)
		require.False(t, res.IsError, res.Text)
		doc := storedTagDoc(t, host, "ws-1")
		require.Contains(t, doc.Tasks, "task-1", "non-string %T must fall back to the caller's task", bad)
		require.Len(t, doc.Tasks, 1)
	}
}

// Decision D4: validating the resolved target means an explicit task_id stands
// on its own when the invocation carries no task of its own, while omitting it
// still produces today's error. Workspace remains mandatory either way.
func TestResolvedTargetSatisfiesContextValidation(t *testing.T) {
	p, host := newAgentTagTestPlugin()
	id := agentCreate(t, p, "Probe")

	withTarget := agentToolReq("add_tag", map[string]any{"tag_id": id, "task_id": "target"})
	withTarget.Context.TaskID = ""
	res, err := p.InvokeAgentTool(context.Background(), withTarget)
	require.NoError(t, err)
	require.False(t, res.IsError, res.Text)
	require.Contains(t, storedTagDoc(t, host, "ws-1").Tasks, "target")

	bare := agentToolReq("add_tag", map[string]any{"tag_id": id})
	bare.Context.TaskID = ""
	res, err = p.InvokeAgentTool(context.Background(), bare)
	require.NoError(t, err)
	require.True(t, res.IsError)
	require.Equal(t, "task_id is required", res.Text)

	noWorkspace := agentToolReq("add_tag", map[string]any{"tag_id": id, "task_id": "target"})
	noWorkspace.Context.WorkspaceID = ""
	res, err = p.InvokeAgentTool(context.Background(), noWorkspace)
	require.NoError(t, err)
	require.True(t, res.IsError)
	require.Equal(t, "workspace_id is required", res.Text)
}

// Retrying a targeted call must update the single entry rather than accumulate
// duplicates, and notes are truncated on a targeted task exactly as on the
// caller's own. Repeated removes stay safe.
func TestTargetedApplicationIsIdempotentAndTruncatesNotes(t *testing.T) {
	p, host := newAgentTagTestPlugin()
	id := agentCreate(t, p, "Probe")
	for i := 0; i < 5; i++ {
		res, err := p.InvokeAgentTool(context.Background(), agentToolReq("add_tag", map[string]any{"tag_id": id, "task_id": "target", "note": fmt.Sprintf("try %d", i)}))
		require.NoError(t, err)
		require.False(t, res.IsError, res.Text)
	}
	entries := storedTagDoc(t, host, "ws-1").Tasks["target"]
	require.Len(t, entries, 1, "replay updates in place")
	require.Equal(t, "try 4", entries[0].Note)

	_, err := p.InvokeAgentTool(context.Background(), agentToolReq("add_tag", map[string]any{"tag_id": id, "task_id": "target", "note": strings.Repeat("é", 500)}))
	require.NoError(t, err)
	require.Len(t, []rune(storedTagDoc(t, host, "ws-1").Tasks["target"][0].Note), maxTagNoteRunes)

	for i := 0; i < 3; i++ {
		res, err := p.InvokeAgentTool(context.Background(), agentToolReq("remove_tag", map[string]any{"tag_id": id, "task_id": "target"}))
		require.NoError(t, err)
		require.False(t, res.IsError, res.Text)
	}
	require.NotContains(t, storedTagDoc(t, host, "ws-1").Tasks, "target")
}

// Targeting does not weaken the mutation lock: concurrent calls aimed at
// distinct tasks must all land.
func TestConcurrentTargetedWritesAllLand(t *testing.T) {
	p, host := newAgentTagTestPlugin()
	id := agentCreate(t, p, "Probe")
	var wg sync.WaitGroup
	const n = 40
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := p.InvokeAgentTool(context.Background(), agentToolReq("add_tag", map[string]any{"tag_id": id, "task_id": fmt.Sprintf("t-%03d", i)}))
			require.NoError(t, err)
		}(i)
	}
	wg.Wait()
	require.Len(t, storedTagDoc(t, host, "ws-1").Tasks, n)
}
