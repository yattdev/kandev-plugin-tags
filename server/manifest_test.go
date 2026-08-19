package main

import (
	"os"
	"regexp"
	"testing"

	"github.com/stretchr/testify/require"
	"gopkg.in/yaml.v3"
)

type testManifest struct {
	ID           string `yaml:"id"`
	Version      string `yaml:"version"`
	Capabilities struct {
		UserState bool `yaml:"user_state"`
		State     bool `yaml:"state"`
	} `yaml:"capabilities"`
	Actions []struct {
		Key   string `yaml:"key"`
		Scope string `yaml:"scope"`
	} `yaml:"actions"`
	AgentTools []struct {
		Name        string   `yaml:"name"`
		Description string   `yaml:"description"`
		Surfaces    []string `yaml:"surfaces"`
		InputSchema struct {
			Type                 string   `yaml:"type"`
			AdditionalProperties bool     `yaml:"additionalProperties"`
			Required             []string `yaml:"required"`
			Properties           map[string]struct {
				Type      string   `yaml:"type"`
				Enum      []string `yaml:"enum"`
				MaxLength int      `yaml:"maxLength"`
			} `yaml:"properties"`
		} `yaml:"input_schema"`
		Annotations struct {
			ReadOnlyHint bool `yaml:"read_only_hint"`
		} `yaml:"annotations"`
	} `yaml:"agent_tools"`
}

func readTestManifest(t *testing.T) testManifest {
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

func TestManifestDeclaresAgentToolsAndActions(t *testing.T) {
	manifest := readTestManifest(t)
	require.Equal(t, "kandev-plugin-tags", manifest.ID)
	require.Equal(t, "0.7.0", manifest.Version)
	require.True(t, manifest.Capabilities.UserState)
	require.True(t, manifest.Capabilities.State)

	actionPattern := regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*$`)
	require.Len(t, manifest.Actions, 2)
	require.Equal(t, "agent-tags", manifest.Actions[0].Key)
	require.Equal(t, "workspace", manifest.Actions[0].Scope)
	require.True(t, actionPattern.MatchString(manifest.Actions[0].Key))
	require.Equal(t, "agent-tag-remove", manifest.Actions[1].Key)
	require.Equal(t, "task", manifest.Actions[1].Scope)
	require.True(t, actionPattern.MatchString(manifest.Actions[1].Key))

	require.Len(t, manifest.AgentTools, 3)
	validEnum := []string{"blocked", "needs-input", "needs-review", "failed", "obsolete", "abandoned"}
	for _, tool := range manifest.AgentTools {
		require.Regexp(t, `^[a-z0-9][a-z0-9_]{0,31}$`, tool.Name)
		require.NotEmpty(t, tool.Description)
		require.LessOrEqual(t, len(tool.Description), 1024)
		require.Equal(t, []string{"kanban-task"}, tool.Surfaces)
		require.Equal(t, "object", tool.InputSchema.Type)
		require.False(t, tool.InputSchema.AdditionalProperties)
		require.LessOrEqual(t, len(exposedAgentToolName(manifest.ID, tool.Name)), 64)
	}

	add := manifest.AgentTools[0]
	require.Equal(t, "add_tag", add.Name)
	require.Equal(t, []string{"tag"}, add.InputSchema.Required)
	require.Equal(t, validEnum, add.InputSchema.Properties["tag"].Enum)
	require.Equal(t, 200, add.InputSchema.Properties["note"].MaxLength)

	remove := manifest.AgentTools[1]
	require.Equal(t, "remove_tag", remove.Name)
	require.Equal(t, []string{"tag"}, remove.InputSchema.Required)
	require.Equal(t, validEnum, remove.InputSchema.Properties["tag"].Enum)

	list := manifest.AgentTools[2]
	require.Equal(t, "list_tags", list.Name)
	require.True(t, list.Annotations.ReadOnlyHint)
	require.Empty(t, list.InputSchema.Required)

	require.Equal(t, "kandev_kandev_plugin_tags_add_tag", exposedAgentToolName(manifest.ID, "add_tag"))
	require.Equal(t, "kandev_kandev_plugin_tags_remove_tag", exposedAgentToolName(manifest.ID, "remove_tag"))
	require.Equal(t, "kandev_kandev_plugin_tags_list_tags", exposedAgentToolName(manifest.ID, "list_tags"))
}

func exposedAgentToolName(pluginID, toolName string) string {
	out := "kandev_"
	for _, r := range pluginID {
		if r == '-' {
			out += "_"
		} else {
			out += string(r)
		}
	}
	return out + "_" + toolName
}
