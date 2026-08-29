package main

import (
	"os"
	"testing"

	"github.com/stretchr/testify/require"
	"gopkg.in/yaml.v3"
)

type testManifest struct {
	Version string `yaml:"version"`
	Actions []struct {
		Key   string `yaml:"key"`
		Scope string `yaml:"scope"`
	} `yaml:"actions"`
	AgentTools []struct {
		Name        string   `yaml:"name"`
		Description string   `yaml:"description"`
		Surfaces    []string `yaml:"surfaces"`
		InputSchema struct {
			Type       string                    `yaml:"type"`
			Required   []string                  `yaml:"required"`
			Properties map[string]map[string]any `yaml:"properties"`
		} `yaml:"input_schema"`
	} `yaml:"agent_tools"`
}

func loadTestManifest(t *testing.T) testManifest {
	t.Helper()
	data, err := os.ReadFile("../manifest.yaml")
	if os.IsNotExist(err) {
		data, err = os.ReadFile("manifest.yaml")
	}
	require.NoError(t, err)
	var manifest testManifest
	require.NoError(t, yaml.Unmarshal(data, &manifest))
	return manifest
}

func TestManifestDeclaresSharedCatalogContract(t *testing.T) {
	manifest := loadTestManifest(t)
	// The release workflow updates the manifest version before it runs the
	// verification suite, so this contract test must validate the version
	// format rather than pinning a particular release number.
	require.Regexp(t, `^[0-9]+\.[0-9]+\.[0-9]+$`, manifest.Version)
	require.Equal(t, []string{"shared-tags", "tag-create", "tag-update", "tag-delete", "task-tag-add", "task-tag-remove"}, func() []string {
		out := make([]string, len(manifest.Actions))
		for i := range manifest.Actions {
			out[i] = manifest.Actions[i].Key
		}
		return out
	}())
	require.Equal(t, []string{"create_tag", "update_tag", "delete_tag", "add_tag", "remove_tag", "list_tags"}, func() []string {
		out := make([]string, len(manifest.AgentTools))
		for i := range manifest.AgentTools {
			out[i] = manifest.AgentTools[i].Name
			require.Equal(t, []string{"kanban-task"}, manifest.AgentTools[i].Surfaces)
			require.Equal(t, "object", manifest.AgentTools[i].InputSchema.Type)
		}
		return out
	}())
}

// The host validates arguments against these schemas and forces
// additionalProperties=false, so an undeclared task_id would be rejected before
// it ever reached the plugin: this contract is what makes cross-task tagging
// reachable at all.
func TestManifestDeclaresOptionalTaskIDOnTaskScopedAgentTools(t *testing.T) {
	manifest := loadTestManifest(t)
	tools := map[string]int{}
	for i := range manifest.AgentTools {
		tools[manifest.AgentTools[i].Name] = i
	}

	// Tools that address a single task's applications accept an optional
	// task_id; it stays out of `required` so omitting it keeps today's
	// caller's-own-task behaviour.
	for _, name := range []string{"add_tag", "remove_tag", "list_tags"} {
		tool := manifest.AgentTools[tools[name]]
		require.Contains(t, tool.InputSchema.Properties, "task_id", name)
		require.Equal(t, "string", tool.InputSchema.Properties["task_id"]["type"], name)
		require.NotContains(t, tool.InputSchema.Required, "task_id", name+" must keep task_id optional")
		require.NotContains(t, tool.Description, "the current task",
			name+" description must not claim it only acts on the current task")
	}

	// Catalog tools operate on the workspace-wide tag list, not on any one
	// task's applications, so they deliberately take no task_id.
	for _, name := range []string{"create_tag", "update_tag", "delete_tag"} {
		tool := manifest.AgentTools[tools[name]]
		require.NotContains(t, tool.InputSchema.Properties, "task_id",
			name+" acts on the catalog, not a task")
	}
}
