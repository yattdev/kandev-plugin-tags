package main

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/kandev/kandev/pkg/pluginsdk"
	"github.com/stretchr/testify/require"
)

func decodeActionBody(t *testing.T, resp *pluginsdk.PluginActionResponse) map[string]any {
	t.Helper()
	var out map[string]any
	require.NoError(t, json.Unmarshal(resp.Body, &out))
	return out
}

func actionReq(key string, body []byte) *pluginsdk.PluginActionRequest {
	return &pluginsdk.PluginActionRequest{
		ActionKey: key,
		Context: pluginsdk.VerifiedActionContext{
			WorkspaceID: "ws-1",
			TaskID:      "task-1",
			ActorID:     "user-1",
		},
		Body: body,
	}
}

func TestHandleActionAgentTagsProjectsVerifiedWorkspace(t *testing.T) {
	p, host := newAgentTagTestPlugin()
	doc1 := newAgentTagDoc()
	doc1.Tasks["task-1"] = []tagEntry{{Tag: "blocked", Note: "waiting", SessionID: "session-1", UpdatedAt: "2026-08-19T00:00:00Z"}}
	doc1.Tasks["task-invalid"] = []tagEntry{{Tag: "unknown", UpdatedAt: "2026-08-19T00:00:01Z"}}
	raw1, err := encodeAgentTagDoc(doc1)
	require.NoError(t, err)
	require.NoError(t, host.SetState(context.Background(), "workspace", "ws-1", agentTagsStateKey, raw1))

	doc2 := newAgentTagDoc()
	doc2.Tasks["task-other"] = []tagEntry{{Tag: "failed", UpdatedAt: "2026-08-19T00:00:00Z"}}
	raw2, err := encodeAgentTagDoc(doc2)
	require.NoError(t, err)
	require.NoError(t, host.SetState(context.Background(), "workspace", "ws-2", agentTagsStateKey, raw2))

	resp, err := p.HandleAction(context.Background(), actionReq("agent-tags", nil))
	require.NoError(t, err)
	require.Equal(t, "application/json", resp.Headers["Content-Type"])
	body := decodeActionBody(t, resp)
	tasks := body["tasks"].(map[string]any)
	require.Contains(t, tasks, "task-1")
	require.NotContains(t, tasks, "task-other")
	require.NotContains(t, tasks, "task-invalid")

	taskTags := tasks["task-1"].([]any)
	require.Len(t, taskTags, 1)
	tag := taskTags[0].(map[string]any)
	require.Equal(t, "blocked", tag["tag"])
	require.Equal(t, "Blocked", tag["label"])
	require.Equal(t, "#dc2626", tag["color"])
	require.Equal(t, "waiting", tag["note"])
	require.Equal(t, "2026-08-19T00:00:00Z", tag["updatedAt"])
}

func TestHandleActionAgentTagRemoveDeletesTag(t *testing.T) {
	p, host := newAgentTagTestPlugin()
	_, err := p.InvokeAgentTool(context.Background(), agentToolReq("add_tag", map[string]any{"tag": "blocked"}))
	require.NoError(t, err)

	resp, err := p.HandleAction(context.Background(), actionReq("agent-tag-remove", []byte(`{"tag":"blocked"}`)))
	require.NoError(t, err)
	body := decodeActionBody(t, resp)
	require.Empty(t, body["tags"].([]any))
	require.NotContains(t, storedAgentDoc(t, host, "ws-1").Tasks, "task-1")
}

func TestHandleActionRejectsUnknownMalformedAndInvalidRequests(t *testing.T) {
	p, _ := newAgentTagTestPlugin()

	_, err := p.HandleAction(context.Background(), actionReq("unknown", nil))
	require.ErrorContains(t, err, "unknown action")

	_, err = p.HandleAction(context.Background(), actionReq("agent-tag-remove", []byte(`{`)))
	require.ErrorContains(t, err, "invalid action body")

	_, err = p.HandleAction(context.Background(), actionReq("agent-tag-remove", []byte(`{"tag":"nonsense"}`)))
	require.ErrorContains(t, err, "invalid tag")
}
