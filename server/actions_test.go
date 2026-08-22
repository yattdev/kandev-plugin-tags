package main

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/kandev/kandev/pkg/pluginsdk"
	"github.com/stretchr/testify/require"
)

func actionReq(key string, body []byte) *pluginsdk.PluginActionRequest {
	return &pluginsdk.PluginActionRequest{ActionKey: key, Context: pluginsdk.VerifiedActionContext{WorkspaceID: "ws-1", TaskID: "task-1", ActorID: "user-1"}, Body: body}
}
func decodeActionBody(t *testing.T, response *pluginsdk.PluginActionResponse) map[string]any {
	t.Helper()
	var body map[string]any
	require.NoError(t, json.Unmarshal(response.Body, &body))
	return body
}

func TestHumanActionsManageAllSharedTags(t *testing.T) {
	p, _ := newAgentTagTestPlugin()
	response, err := p.HandleAction(context.Background(), actionReq("tag-create", []byte(`{"name":"Ready","color":"#3b82f6"}`)))
	require.NoError(t, err)
	body := decodeActionBody(t, response)
	tag := body["tags"].([]any)[0].(map[string]any)
	require.Equal(t, ownerHuman, tag["owner"])
	id := tag["id"].(string)

	_, err = p.HandleAction(context.Background(), actionReq("task-tag-add", []byte(`{"tagId":"`+id+`"}`)))
	require.NoError(t, err)
	response, err = p.HandleAction(context.Background(), actionReq("shared-tags", nil))
	require.NoError(t, err)
	body = decodeActionBody(t, response)
	entry := body["tasks"].(map[string]any)["task-1"].([]any)[0].(map[string]any)
	require.True(t, entry["human"].(bool))
	require.False(t, entry["agent"].(bool))

	_, err = p.HandleAction(context.Background(), actionReq("tag-update", []byte(`{"id":"`+id+`","name":"Done","color":"#22c55e"}`)))
	require.NoError(t, err)
	_, err = p.HandleAction(context.Background(), actionReq("tag-delete", []byte(`{"id":"`+id+`"}`)))
	require.NoError(t, err)
	response, err = p.HandleAction(context.Background(), actionReq("shared-tags", nil))
	require.NoError(t, err)
	body = decodeActionBody(t, response)
	require.Empty(t, body["tags"])
	require.Empty(t, body["tasks"])
}

func TestActionsRejectMalformedOrUnverifiedRequests(t *testing.T) {
	p, _ := newAgentTagTestPlugin()
	_, err := p.HandleAction(context.Background(), actionReq("unknown", nil))
	require.ErrorContains(t, err, "unknown action")
	_, err = p.HandleAction(context.Background(), actionReq("tag-create", []byte(`{`)))
	require.ErrorContains(t, err, "invalid action body")
	req := actionReq("shared-tags", nil)
	req.Context.WorkspaceID = ""
	_, err = p.HandleAction(context.Background(), req)
	require.ErrorContains(t, err, "workspace_id")
}
