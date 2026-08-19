package main

import (
	"sync"

	"github.com/kandev/kandev/pkg/pluginsdk"
)

// tagsPlugin serves the workspace-shared agent status-tag layer. User-created
// tags remain private and are still handled by the browser through host.storage.
type tagsPlugin struct {
	pluginsdk.UnimplementedPlugin
	stateMu sync.Mutex
}

var (
	_ pluginsdk.Plugin          = (*tagsPlugin)(nil)
	_ pluginsdk.AgentToolPlugin = (*tagsPlugin)(nil)
	_ pluginsdk.ActionHandler   = (*tagsPlugin)(nil)
)
