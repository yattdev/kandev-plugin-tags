package main

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/kandev/kandev/pkg/pluginsdk"
)

func jsonAction(value any) (*pluginsdk.PluginActionResponse, error) {
	body, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return &pluginsdk.PluginActionResponse{Body: body, Headers: map[string]string{"Content-Type": "application/json"}}, nil
}
func agentTagView(entries []tagEntry) []map[string]any {
	out := make([]map[string]any, 0, len(entries))
	for _, entry := range sortedEntries(entries) {
		tag, ok := validAgentTag(entry.Tag)
		if !ok {
			continue
		}
		out = append(out, map[string]any{"tag": tag.Slug, "label": tag.Label, "color": tag.Color, "note": entry.Note, "updatedAt": entry.UpdatedAt})
	}
	return out
}
func (p *tagsPlugin) HandleAction(ctx context.Context, req *pluginsdk.PluginActionRequest) (*pluginsdk.PluginActionResponse, error) {
	if req == nil {
		return nil, fmt.Errorf("action request is missing")
	}
	switch req.ActionKey {
	case "agent-tags":
		if req.Context.WorkspaceID == "" {
			return nil, fmt.Errorf("workspace_id is required")
		}
		doc, err := p.readWorkspaceDoc(ctx, req.Context.WorkspaceID)
		if err != nil {
			return nil, err
		}
		tasks := map[string]any{}
		for id, entries := range doc.Tasks {
			if view := agentTagView(entries); len(view) > 0 {
				tasks[id] = view
			}
		}
		return jsonAction(map[string]any{"tasks": tasks})
	case "agent-tag-remove":
		if req.Context.WorkspaceID == "" || req.Context.TaskID == "" {
			return nil, fmt.Errorf("workspace_id and task_id are required")
		}
		var body struct {
			Tag string `json:"tag"`
		}
		if err := json.Unmarshal(req.Body, &body); err != nil {
			return nil, fmt.Errorf("invalid action body: %w", err)
		}
		if _, ok := validAgentTag(body.Tag); !ok {
			return nil, fmt.Errorf("invalid tag; valid tags: %s", validAgentTagNames())
		}
		doc, err := p.mutateWorkspaceDoc(ctx, req.Context.WorkspaceID, func(doc *agentTagDoc) {
			entries := doc.Tasks[req.Context.TaskID]
			kept := entries[:0]
			for _, entry := range entries {
				if entry.Tag != body.Tag {
					kept = append(kept, entry)
				}
			}
			if len(kept) == 0 {
				delete(doc.Tasks, req.Context.TaskID)
			} else {
				doc.Tasks[req.Context.TaskID] = kept
			}
		})
		if err != nil {
			return nil, err
		}
		return jsonAction(map[string]any{"tags": agentTagView(doc.Tasks[req.Context.TaskID])})
	default:
		return nil, fmt.Errorf("unknown action: %s", req.ActionKey)
	}
}
