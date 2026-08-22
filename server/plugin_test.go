// Package main tests tagsPlugin's baseline SDK wiring and provides a fake
// Host for the agent-tag tests.
package main

import (
	"context"
	"encoding/json"
	"sync"
	"testing"

	"github.com/kandev/kandev/pkg/pluginsdk"
	"github.com/stretchr/testify/require"
)

func TestTagsPlugin_SatisfiesPluginInterface(t *testing.T) {
	var _ pluginsdk.Plugin = (*tagsPlugin)(nil)
	var _ pluginsdk.AgentToolPlugin = (*tagsPlugin)(nil)
	var _ pluginsdk.ActionHandler = (*tagsPlugin)(nil)
}

func TestTagsPlugin_OnEvent_NoHost_ReturnsNilWithoutPanicking(t *testing.T) {
	p := &tagsPlugin{}
	err := p.OnEvent(context.Background(), &pluginsdk.Event{EventID: "e1", EventType: "task.created"})
	require.NoError(t, err)
}

func TestTagsPlugin_HandleWebhook_NoHandlerDeclared_Returns404(t *testing.T) {
	p := &tagsPlugin{}
	resp, err := p.HandleWebhook(context.Background(), &pluginsdk.WebhookRequest{WebhookKey: "unused"})
	require.NoError(t, err)
	require.Equal(t, int32(404), resp.Status)
}

func TestTagsPlugin_HostRoundTrip(t *testing.T) {
	p := &tagsPlugin{}
	require.Nil(t, p.Host())

	host := &fakeHost{}
	p.SetHost(host)
	require.Same(t, pluginsdk.Host(host), p.Host())
}

// fakeHost is an in-memory pluginsdk.Host stand-in for backend tests.
type fakeHost struct {
	pluginsdk.UnimplementedHostData
	mu    sync.Mutex
	state map[string]map[string]any
}

func stateKey(scope, scopeID, key string) string {
	return scope + "\x00" + scopeID + "\x00" + key
}

func cloneMap(value map[string]any) map[string]any {
	if value == nil {
		return nil
	}
	b, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	var out map[string]any
	if err := json.Unmarshal(b, &out); err != nil {
		panic(err)
	}
	return out
}

func (h *fakeHost) GetState(_ context.Context, scope, scopeID, key string) (map[string]any, bool, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.state == nil {
		return nil, false, nil
	}
	value, ok := h.state[stateKey(scope, scopeID, key)]
	return cloneMap(value), ok, nil
}
func (h *fakeHost) SetState(_ context.Context, scope, scopeID, key string, value map[string]any) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.state == nil {
		h.state = map[string]map[string]any{}
	}
	h.state[stateKey(scope, scopeID, key)] = cloneMap(value)
	return nil
}
func (h *fakeHost) DeleteState(_ context.Context, scope, scopeID, key string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.state, stateKey(scope, scopeID, key))
	return nil
}
func (h *fakeHost) ListState(context.Context, string, string) ([]pluginsdk.StateEntry, error) {
	return nil, nil
}
func (h *fakeHost) GetConfig(context.Context) (map[string]any, error)    { return map[string]any{}, nil }
func (h *fakeHost) RevealSecret(context.Context, string) (string, error) { return "", nil }
func (h *fakeHost) GetSecret(context.Context, string) (string, bool, error) {
	return "", false, nil
}
func (h *fakeHost) SetSecret(context.Context, string, string) error         { return nil }
func (h *fakeHost) DeleteSecret(context.Context, string) error              { return nil }
func (h *fakeHost) EmitEvent(context.Context, string, map[string]any) error { return nil }

var _ pluginsdk.Host = (*fakeHost)(nil)
