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
		Surfaces    []string `yaml:"surfaces"`
		InputSchema struct {
			Type     string   `yaml:"type"`
			Required []string `yaml:"required"`
		} `yaml:"input_schema"`
	} `yaml:"agent_tools"`
}

func TestManifestDeclaresSharedCatalogContract(t *testing.T) {
	data, err := os.ReadFile("../manifest.yaml")
	if os.IsNotExist(err) {
		data, err = os.ReadFile("manifest.yaml")
	}
	require.NoError(t, err)
	var manifest testManifest
	require.NoError(t, yaml.Unmarshal(data, &manifest))
	require.Equal(t, "0.8.3", manifest.Version)
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
