package main

import (
	"sync"

	"github.com/kandev/kandev/pkg/pluginsdk"
)

// tagsPlugin serves the workspace-shared tag catalog through Host state and
// authorized plugin actions. Legacy private browser tags remain a read-only
// compatibility layer in the UI.
type tagsPlugin struct {
	pluginsdk.UnimplementedPlugin
	stateMu sync.Mutex
}

var (
	_ pluginsdk.Plugin          = (*tagsPlugin)(nil)
	_ pluginsdk.AgentToolPlugin = (*tagsPlugin)(nil)
	_ pluginsdk.ActionHandler   = (*tagsPlugin)(nil)
)
