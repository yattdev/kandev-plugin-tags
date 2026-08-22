// Command kandev-plugin-tags is the backend half of the Tags plugin. Kandev
// spawns it as a gRPC subprocess; it does not expose an HTTP server or listen
// address. The plugin provides agent tools and actions for shared agent-status
// tags, persisting their workspace-scoped state through the plugin host. The
// frontend UI bundle continues to manage users' private task tags.
package main

import "github.com/kandev/kandev/pkg/pluginsdk"

func main() {
	pluginsdk.Serve(&tagsPlugin{})
}
