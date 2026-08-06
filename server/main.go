// Command kandev-plugin-tags is the backend half of the Tags plugin. It
// implements pluginsdk.Plugin as a no-op (via UnimplementedPlugin) and is
// spawned by kandev as a gRPC subprocess -- there is no HTTP server, no
// listen address, and nothing for it to do. All tag behavior (add/remove/
// display) lives in the frontend UI bundle (ui/bundle.js), which reads and
// writes tags through host.storage (scope "task"), a purely browser-side,
// per-user API that needs no backend involvement. This binary exists only
// because runtime.type: binary requires one.
package main

import "github.com/kandev/kandev/pkg/pluginsdk"

func main() {
	pluginsdk.Serve(&tagsPlugin{})
}
