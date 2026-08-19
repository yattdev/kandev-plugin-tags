package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/kandev/kandev/pkg/pluginsdk"
)

const (
	agentTagsStateKey = "agent-tags"
	agentTagTaskCap   = 200
)

type agentTag struct{ Slug, Label, Color string }

var agentTagVocabulary = []agentTag{
	{"blocked", "Blocked", "#dc2626"}, {"needs-input", "Needs input", "#f59e0b"},
	{"needs-review", "Needs review", "#2563eb"}, {"failed", "Failed", "#b91c1c"},
	{"obsolete", "Obsolete", "#6b7280"}, {"abandoned", "Abandoned", "#78716c"},
}

type tagEntry struct {
	Tag       string `json:"tag"`
	Note      string `json:"note"`
	SessionID string `json:"session_id"`
	UpdatedAt string `json:"updated_at"`
}
type agentTagDoc struct {
	Version int                   `json:"version"`
	Tasks   map[string][]tagEntry `json:"tasks"`
}

func validAgentTag(slug string) (agentTag, bool) {
	for _, tag := range agentTagVocabulary {
		if tag.Slug == slug {
			return tag, true
		}
	}
	return agentTag{}, false
}
func validAgentTagNames() string {
	names := make([]string, len(agentTagVocabulary))
	for i, tag := range agentTagVocabulary {
		names[i] = tag.Slug
	}
	return strings.Join(names, ", ")
}
func newAgentTagDoc() agentTagDoc { return agentTagDoc{Version: 1, Tasks: map[string][]tagEntry{}} }

func decodeAgentTagDoc(raw map[string]any) (agentTagDoc, error) {
	if len(raw) == 0 {
		return newAgentTagDoc(), nil
	}
	b, err := json.Marshal(raw)
	if err != nil {
		return agentTagDoc{}, err
	}
	doc := newAgentTagDoc()
	if err := json.Unmarshal(b, &doc); err != nil {
		return agentTagDoc{}, err
	}
	if doc.Tasks == nil {
		doc.Tasks = map[string][]tagEntry{}
	}
	if doc.Version == 0 {
		doc.Version = 1
	}
	return doc, nil
}
func encodeAgentTagDoc(doc agentTagDoc) (map[string]any, error) {
	b, err := json.Marshal(doc)
	if err != nil {
		return nil, err
	}
	var raw map[string]any
	err = json.Unmarshal(b, &raw)
	return raw, err
}
func truncateNote(note string) string {
	r := []rune(note)
	if len(r) > 200 {
		r = r[:200]
	}
	return string(r)
}
func sortedEntries(entries []tagEntry) []tagEntry {
	out := append([]tagEntry(nil), entries...)
	sort.SliceStable(out, func(i, j int) bool { return out[i].UpdatedAt < out[j].UpdatedAt })
	return out
}

func (p *tagsPlugin) readWorkspaceDoc(ctx context.Context, workspaceID string) (agentTagDoc, error) {
	host := p.Host()
	if host == nil {
		return agentTagDoc{}, fmt.Errorf("plugin host is unavailable")
	}
	raw, found, err := host.GetState(ctx, "workspace", workspaceID, agentTagsStateKey)
	if err != nil {
		return agentTagDoc{}, err
	}
	if !found {
		return newAgentTagDoc(), nil
	}
	return decodeAgentTagDoc(raw)
}
func (p *tagsPlugin) mutateWorkspaceDoc(ctx context.Context, workspaceID string, mutate func(*agentTagDoc)) (agentTagDoc, error) {
	p.stateMu.Lock()
	defer p.stateMu.Unlock()
	doc, err := p.readWorkspaceDoc(ctx, workspaceID)
	if err != nil {
		return agentTagDoc{}, err
	}
	mutate(&doc)
	p.capAgentTagTasks(&doc)
	raw, err := encodeAgentTagDoc(doc)
	if err != nil {
		return agentTagDoc{}, err
	}
	if err := p.Host().SetState(ctx, "workspace", workspaceID, agentTagsStateKey, raw); err != nil {
		return agentTagDoc{}, err
	}
	return doc, nil
}
func (p *tagsPlugin) capAgentTagTasks(doc *agentTagDoc) {
	for len(doc.Tasks) > agentTagTaskCap {
		var oldestID, oldest string
		for id, entries := range doc.Tasks {
			updated := ""
			for _, entry := range entries {
				if updated == "" || entry.UpdatedAt < updated {
					updated = entry.UpdatedAt
				}
			}
			if oldestID == "" || updated < oldest {
				oldestID, oldest = id, updated
			}
		}
		delete(doc.Tasks, oldestID)
	}
}
func agentToolError(text string) *pluginsdk.AgentToolResult {
	return &pluginsdk.AgentToolResult{Text: text, IsError: true}
}
func requireToolContext(req *pluginsdk.AgentToolRequest) string {
	if req == nil {
		return "request is missing"
	}
	if req.Context.TaskID == "" {
		return "task_id is required"
	}
	if req.Context.WorkspaceID == "" {
		return "workspace_id is required"
	}
	return ""
}
func toolTag(req *pluginsdk.AgentToolRequest) (string, string) {
	tag, _ := req.Arguments["tag"].(string)
	note, _ := req.Arguments["note"].(string)
	return tag, truncateNote(note)
}
func resultForEntries(text string, entries []tagEntry) *pluginsdk.AgentToolResult {
	tags := make([]any, len(entries))
	for i, e := range sortedEntries(entries) {
		tags[i] = e.Tag
	}
	return &pluginsdk.AgentToolResult{Text: text, StructuredContent: map[string]any{"tags": tags}}
}

func (p *tagsPlugin) InvokeAgentTool(ctx context.Context, req *pluginsdk.AgentToolRequest) (*pluginsdk.AgentToolResult, error) {
	if msg := requireToolContext(req); msg != "" {
		return agentToolError(msg), nil
	}
	switch req.Name {
	case "add_tag":
		tag, note := toolTag(req)
		if _, ok := validAgentTag(tag); !ok {
			return agentToolError("invalid tag; valid tags: " + validAgentTagNames()), nil
		}
		doc, err := p.mutateWorkspaceDoc(ctx, req.Context.WorkspaceID, func(doc *agentTagDoc) {
			entries := doc.Tasks[req.Context.TaskID]
			now := time.Now().UTC().Format(time.RFC3339Nano)
			replaced := false
			for i := range entries {
				if entries[i].Tag == tag {
					entries[i] = tagEntry{Tag: tag, Note: note, SessionID: req.Context.SessionID, UpdatedAt: now}
					replaced = true
				}
			}
			if !replaced {
				entries = append(entries, tagEntry{Tag: tag, Note: note, SessionID: req.Context.SessionID, UpdatedAt: now})
			}
			doc.Tasks[req.Context.TaskID] = entries
		})
		if err != nil {
			return nil, err
		}
		return resultForEntries("added agent tag "+tag, doc.Tasks[req.Context.TaskID]), nil
	case "remove_tag":
		tag, _ := toolTag(req)
		if _, ok := validAgentTag(tag); !ok {
			return agentToolError("invalid tag; valid tags: " + validAgentTagNames()), nil
		}
		doc, err := p.mutateWorkspaceDoc(ctx, req.Context.WorkspaceID, func(doc *agentTagDoc) {
			entries := doc.Tasks[req.Context.TaskID]
			kept := entries[:0]
			for _, entry := range entries {
				if entry.Tag != tag {
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
		return resultForEntries("removed agent tag "+tag, doc.Tasks[req.Context.TaskID]), nil
	case "list_tags":
		doc, err := p.readWorkspaceDoc(ctx, req.Context.WorkspaceID)
		if err != nil {
			return nil, err
		}
		return resultForEntries("listed agent tags", doc.Tasks[req.Context.TaskID]), nil
	default:
		return agentToolError("unknown agent tool: " + req.Name), nil
	}
}
