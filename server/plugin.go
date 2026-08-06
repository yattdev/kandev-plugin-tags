package main

import "github.com/kandev/kandev/pkg/pluginsdk"

// tagsPlugin is a deliberate no-op backend: it embeds UnimplementedPlugin and
// overrides nothing. Tags are per-user data read and written entirely by the
// frontend against host.storage (scope "task"), so this plugin declares no
// events, no webhooks, and no config -- the backend process exists solely to
// satisfy manifest.yaml's runtime.type: binary requirement.
type tagsPlugin struct {
	pluginsdk.UnimplementedPlugin
}

var _ pluginsdk.Plugin = (*tagsPlugin)(nil)
