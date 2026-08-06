// Package main tests. tagsPlugin is a deliberate no-op backend (see
// plugin.go) -- this test only asserts it satisfies pluginsdk.Plugin and
// that its inherited UnimplementedPlugin defaults behave as documented
// (nil Host is safe, OnEvent is a no-op, HandleWebhook answers 404 since no
// webhook is declared). There is no tag logic to test here; that lives in
// ui/bundle.js and ui/bundle.test.js.
package main

import (
	"context"
	"testing"

	"github.com/kandev/kandev/pkg/pluginsdk"
	"github.com/stretchr/testify/require"
)

func TestTagsPlugin_SatisfiesPluginInterface(t *testing.T) {
	var _ pluginsdk.Plugin = (*tagsPlugin)(nil)
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

// fakeHost is a minimal pluginsdk.Host stand-in for the SetHost/Host
// round-trip test above; tagsPlugin never calls any Host method itself.
type fakeHost struct {
	pluginsdk.UnimplementedHostData
}

func (h *fakeHost) GetState(context.Context, string, string, string) (map[string]any, bool, error) {
	return nil, false, nil
}
func (h *fakeHost) SetState(context.Context, string, string, string, map[string]any) error {
	return nil
}
func (h *fakeHost) DeleteState(context.Context, string, string, string) error { return nil }
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
