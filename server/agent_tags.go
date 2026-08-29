package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/kandev/kandev/pkg/pluginsdk"
)

const (
	// tagStateKey deliberately keeps the original key. Version 2 turns the
	// former agent-only status document into the shared workspace catalog.
	tagStateKey     = "agent-tags"
	tagTaskCap      = 200
	maxTagNameRunes = 22
	maxTagNoteRunes = 200
	defaultTagColor = "#6b7280"
	ownerAgent      = "agent"
	ownerHuman      = "human"
)

var hexColor = regexp.MustCompile(`^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$`)

// sharedTag is workspace-visible. Owner is an origin rather than an identity:
// agent tools have no user identity and every authenticated human may manage
// the shared catalog.
type sharedTag struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Color     string `json:"color"`
	Owner     string `json:"owner"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

// taskTag represents one visual chip. Keeping human and agent application
// separately means an agent cannot remove a human application of the same tag.
type taskTag struct {
	TagID     string `json:"tag_id"`
	Agent     bool   `json:"agent"`
	Human     bool   `json:"human"`
	Note      string `json:"note"`
	SessionID string `json:"session_id"`
	UpdatedAt string `json:"updated_at"`
}

type tagDoc struct {
	Version int                  `json:"version"`
	Tags    []sharedTag          `json:"tags"`
	Tasks   map[string][]taskTag `json:"tasks"`
}

// legacyTagDoc decodes the 0.7.0 static-status document so existing agent
// applications continue to render after the shared-catalog upgrade.
type legacyTagEntry struct {
	Tag       string `json:"tag"`
	Note      string `json:"note"`
	SessionID string `json:"session_id"`
	UpdatedAt string `json:"updated_at"`
}
type legacyTagDoc struct {
	Version int                         `json:"version"`
	Tasks   map[string][]legacyTagEntry `json:"tasks"`
}

func newTagDoc() tagDoc {
	return tagDoc{Version: 2, Tags: []sharedTag{}, Tasks: map[string][]taskTag{}}
}

func decodeTagDoc(raw map[string]any) (tagDoc, error) {
	if len(raw) == 0 {
		return newTagDoc(), nil
	}
	b, err := json.Marshal(raw)
	if err != nil {
		return tagDoc{}, err
	}
	var probe struct {
		Tags json.RawMessage `json:"tags"`
	}
	if err := json.Unmarshal(b, &probe); err != nil {
		return tagDoc{}, err
	}
	if len(probe.Tags) == 0 || string(probe.Tags) == "null" {
		var legacy legacyTagDoc
		if err := json.Unmarshal(b, &legacy); err != nil {
			return tagDoc{}, err
		}
		return migrateLegacyTagDoc(legacy), nil
	}
	doc := newTagDoc()
	if err := json.Unmarshal(b, &doc); err != nil {
		return tagDoc{}, err
	}
	if doc.Tasks == nil {
		doc.Tasks = map[string][]taskTag{}
	}
	if doc.Tags == nil {
		doc.Tags = []sharedTag{}
	}
	doc.Version = 2
	return doc, nil
}

func migrateLegacyTagDoc(legacy legacyTagDoc) tagDoc {
	doc := newTagDoc()
	for taskID, entries := range legacy.Tasks {
		for _, entry := range entries {
			id := "agent-legacy-" + strings.TrimSpace(entry.Tag)
			if id == "agent-legacy-" {
				continue
			}
			if findTag(doc.Tags, id) == nil {
				doc.Tags = append(doc.Tags, sharedTag{ID: id, Name: titleFromSlug(entry.Tag), Color: defaultTagColor, Owner: ownerAgent, CreatedAt: entry.UpdatedAt, UpdatedAt: entry.UpdatedAt})
			}
			doc.Tasks[taskID] = append(doc.Tasks[taskID], taskTag{TagID: id, Agent: true, Note: truncateNote(entry.Note), SessionID: entry.SessionID, UpdatedAt: entry.UpdatedAt})
		}
	}
	return doc
}

func titleFromSlug(v string) string {
	words := strings.Fields(strings.ReplaceAll(strings.TrimSpace(v), "-", " "))
	for i := range words {
		if words[i] != "" {
			words[i] = strings.ToUpper(words[i][:1]) + words[i][1:]
		}
	}
	return strings.Join(words, " ")
}

func encodeTagDoc(doc tagDoc) (map[string]any, error) {
	b, err := json.Marshal(doc)
	if err != nil {
		return nil, err
	}
	var raw map[string]any
	err = json.Unmarshal(b, &raw)
	return raw, err
}

func normalizeTagName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", fmt.Errorf("tag name is required")
	}
	if utf8.RuneCountInString(name) > maxTagNameRunes {
		return "", fmt.Errorf("tag name must be at most %d characters", maxTagNameRunes)
	}
	return name, nil
}

func normalizeTagColor(color string) (string, error) {
	color = strings.TrimSpace(color)
	if color == "" {
		return defaultTagColor, nil
	}
	if !hexColor.MatchString(color) {
		return "", fmt.Errorf("color must be a 3- or 6-digit hex value")
	}
	color = strings.ToLower(color)
	if len(color) == 4 {
		return fmt.Sprintf("#%c%c%c%c%c%c", color[1], color[1], color[2], color[2], color[3], color[3]), nil
	}
	return color, nil
}

func truncateNote(note string) string {
	r := []rune(note)
	if len(r) > maxTagNoteRunes {
		r = r[:maxTagNoteRunes]
	}
	return string(r)
}

func findTag(tags []sharedTag, id string) *sharedTag {
	for i := range tags {
		if tags[i].ID == id {
			return &tags[i]
		}
	}
	return nil
}
func findTagIndex(tags []sharedTag, id string) int {
	for i := range tags {
		if tags[i].ID == id {
			return i
		}
	}
	return -1
}
func hasTagName(tags []sharedTag, name, exceptID string) bool {
	for _, tag := range tags {
		if tag.ID != exceptID && strings.EqualFold(tag.Name, name) {
			return true
		}
	}
	return false
}
func findTaskTagIndex(entries []taskTag, tagID string) int {
	for i := range entries {
		if entries[i].TagID == tagID {
			return i
		}
	}
	return -1
}
func now() string { return time.Now().UTC().Format(time.RFC3339Nano) }
func newTagID() (string, error) {
	b := make([]byte, 10)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "tag-" + hex.EncodeToString(b), nil
}

func (p *tagsPlugin) readTagDoc(ctx context.Context, workspaceID string) (tagDoc, error) {
	host := p.Host()
	if host == nil {
		return tagDoc{}, fmt.Errorf("plugin host is unavailable")
	}
	raw, found, err := host.GetState(ctx, "workspace", workspaceID, tagStateKey)
	if err != nil {
		return tagDoc{}, err
	}
	if !found {
		return newTagDoc(), nil
	}
	return decodeTagDoc(raw)
}
func (p *tagsPlugin) mutateTagDoc(ctx context.Context, workspaceID string, mutate func(*tagDoc) error) (tagDoc, error) {
	p.stateMu.Lock()
	defer p.stateMu.Unlock()
	doc, err := p.readTagDoc(ctx, workspaceID)
	if err != nil {
		return tagDoc{}, err
	}
	if err := mutate(&doc); err != nil {
		return tagDoc{}, err
	}
	p.capTagTasks(&doc)
	raw, err := encodeTagDoc(doc)
	if err != nil {
		return tagDoc{}, err
	}
	if err := p.Host().SetState(ctx, "workspace", workspaceID, tagStateKey, raw); err != nil {
		return tagDoc{}, err
	}
	return doc, nil
}
func (p *tagsPlugin) capTagTasks(doc *tagDoc) {
	for len(doc.Tasks) > tagTaskCap {
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

func requireToolContext(req *pluginsdk.AgentToolRequest) string {
	if req == nil {
		return "request is missing"
	}
	// Validating the resolved target rather than the raw context keeps the
	// existing error for a callerless invocation while letting an explicit
	// task_id stand on its own.
	if targetTaskID(req) == "" {
		return "task_id is required"
	}
	if req.Context.WorkspaceID == "" {
		return "workspace_id is required"
	}
	return ""
}

// targetTaskID resolves the task a tool acts on: the optional task_id argument
// when supplied, otherwise the calling agent's own task. This is the single
// fallback point -- no call site reads req.Context.TaskID directly.
//
// A supplied ID is not verified to name a real task; the plugin has no platform
// client to ask. It needs no verification: doc.Tasks is a map inside the
// caller's own workspace document, so a target can only ever address a task in
// that workspace, and an entry for a task that does not exist renders nowhere
// and is reaped by capTagTasks eviction and the deleteTag cascade.
func targetTaskID(req *pluginsdk.AgentToolRequest) string {
	if id := strings.TrimSpace(agentArgString(req, "task_id")); id != "" {
		return id
	}
	return req.Context.TaskID
}
func agentToolError(text string) *pluginsdk.AgentToolResult {
	return &pluginsdk.AgentToolResult{Text: text, IsError: true}
}
func agentArgString(req *pluginsdk.AgentToolRequest, key string) string {
	value, _ := req.Arguments[key].(string)
	return value
}

func sortedTaskTags(entries []taskTag) []taskTag {
	out := append([]taskTag(nil), entries...)
	sort.SliceStable(out, func(i, j int) bool { return out[i].UpdatedAt < out[j].UpdatedAt })
	return out
}
func taskTagView(doc tagDoc, entries []taskTag) []any {
	out := make([]any, 0, len(entries))
	for _, entry := range sortedTaskTags(entries) {
		tag := findTag(doc.Tags, entry.TagID)
		if tag == nil {
			continue
		}
		// The bot distinction describes either agent provenance: a tag created
		// by an agent remains visibly agent-owned even if a person later adds
		// it to another card, and an agent application marks a human-owned
		// definition only while that application remains present.
		out = append(out, map[string]any{"id": tag.ID, "name": tag.Name, "color": tag.Color, "owner": tag.Owner, "agent": entry.Agent || tag.Owner == ownerAgent, "agentApplied": entry.Agent, "human": entry.Human, "note": entry.Note, "updatedAt": entry.UpdatedAt})
	}
	return out
}
func catalogView(doc tagDoc) []any {
	out := make([]any, 0, len(doc.Tags))
	for _, tag := range doc.Tags {
		out = append(out, map[string]any{"id": tag.ID, "name": tag.Name, "color": tag.Color, "owner": tag.Owner, "createdAt": tag.CreatedAt, "updatedAt": tag.UpdatedAt})
	}
	return out
}
func agentResult(text string, doc tagDoc, taskID string) *pluginsdk.AgentToolResult {
	return &pluginsdk.AgentToolResult{Text: text, StructuredContent: map[string]any{"catalog": catalogView(doc), "tags": taskTagView(doc, doc.Tasks[taskID])}}
}
func requireAgentOwnedTag(doc tagDoc, id string) (*sharedTag, error) {
	tag := findTag(doc.Tags, id)
	if tag == nil {
		return nil, fmt.Errorf("tag %q does not exist", id)
	}
	if tag.Owner != ownerAgent {
		return nil, fmt.Errorf("agents can only manage agent-created tags")
	}
	return tag, nil
}

func (p *tagsPlugin) InvokeAgentTool(ctx context.Context, req *pluginsdk.AgentToolRequest) (*pluginsdk.AgentToolResult, error) {
	if msg := requireToolContext(req); msg != "" {
		return agentToolError(msg), nil
	}
	taskID := targetTaskID(req)
	switch req.Name {
	case "create_tag":
		name, err := normalizeTagName(agentArgString(req, "name"))
		if err != nil {
			return agentToolError(err.Error()), nil
		}
		color, err := normalizeTagColor(agentArgString(req, "color"))
		if err != nil {
			return agentToolError(err.Error()), nil
		}
		var created sharedTag
		doc, err := p.mutateTagDoc(ctx, req.Context.WorkspaceID, func(doc *tagDoc) error {
			if hasTagName(doc.Tags, name, "") {
				return fmt.Errorf("a tag named %q already exists", name)
			}
			id, err := newTagID()
			if err != nil {
				return err
			}
			timestamp := now()
			created = sharedTag{ID: id, Name: name, Color: color, Owner: ownerAgent, CreatedAt: timestamp, UpdatedAt: timestamp}
			doc.Tags = append(doc.Tags, created)
			return nil
		})
		if err != nil {
			return agentToolError(err.Error()), nil
		}
		return agentResult("created agent tag "+created.Name, doc, taskID), nil
	case "update_tag":
		id := agentArgString(req, "tag_id")
		nameArg, colorArg := agentArgString(req, "name"), agentArgString(req, "color")
		if id == "" {
			return agentToolError("tag_id is required"), nil
		}
		if nameArg == "" && colorArg == "" {
			return agentToolError("name or color is required"), nil
		}
		doc, err := p.mutateTagDoc(ctx, req.Context.WorkspaceID, func(doc *tagDoc) error {
			tag, err := requireAgentOwnedTag(*doc, id)
			if err != nil {
				return err
			}
			if nameArg != "" {
				name, err := normalizeTagName(nameArg)
				if err != nil {
					return err
				}
				if hasTagName(doc.Tags, name, id) {
					return fmt.Errorf("a tag named %q already exists", name)
				}
				tag.Name = name
			}
			if colorArg != "" {
				color, err := normalizeTagColor(colorArg)
				if err != nil {
					return err
				}
				tag.Color = color
			}
			tag.UpdatedAt = now()
			doc.Tags[findTagIndex(doc.Tags, id)] = *tag
			return nil
		})
		if err != nil {
			return agentToolError(err.Error()), nil
		}
		return agentResult("updated agent tag", doc, taskID), nil
	case "delete_tag":
		id := agentArgString(req, "tag_id")
		if id == "" {
			return agentToolError("tag_id is required"), nil
		}
		doc, err := p.mutateTagDoc(ctx, req.Context.WorkspaceID, func(doc *tagDoc) error {
			if _, err := requireAgentOwnedTag(*doc, id); err != nil {
				return err
			}
			deleteTag(doc, id)
			return nil
		})
		if err != nil {
			return agentToolError(err.Error()), nil
		}
		return agentResult("deleted agent tag", doc, taskID), nil
	case "add_tag":
		id := agentArgString(req, "tag_id")
		if id == "" {
			return agentToolError("tag_id is required"), nil
		}
		note := truncateNote(agentArgString(req, "note"))
		doc, err := p.mutateTagDoc(ctx, req.Context.WorkspaceID, func(doc *tagDoc) error {
			if _, err := requireAgentOwnedTag(*doc, id); err != nil {
				return err
			}
			entries := doc.Tasks[taskID]
			i := findTaskTagIndex(entries, id)
			timestamp := now()
			if i < 0 {
				entries = append(entries, taskTag{TagID: id, Agent: true, Note: note, SessionID: req.Context.SessionID, UpdatedAt: timestamp})
			} else {
				entries[i].Agent = true
				entries[i].Note = note
				entries[i].SessionID = req.Context.SessionID
				entries[i].UpdatedAt = timestamp
			}
			doc.Tasks[taskID] = entries
			return nil
		})
		if err != nil {
			return agentToolError(err.Error()), nil
		}
		return agentResult("added agent tag", doc, taskID), nil
	case "remove_tag":
		id := agentArgString(req, "tag_id")
		if id == "" {
			return agentToolError("tag_id is required"), nil
		}
		doc, err := p.mutateTagDoc(ctx, req.Context.WorkspaceID, func(doc *tagDoc) error {
			if _, err := requireAgentOwnedTag(*doc, id); err != nil {
				return err
			}
			removeAgentApplication(doc, taskID, id)
			return nil
		})
		if err != nil {
			return agentToolError(err.Error()), nil
		}
		return agentResult("removed agent tag", doc, taskID), nil
	case "list_tags":
		doc, err := p.readTagDoc(ctx, req.Context.WorkspaceID)
		if err != nil {
			return nil, err
		}
		return agentResult("listed shared tags", doc, taskID), nil
	default:
		return agentToolError("unknown agent tool: " + req.Name), nil
	}
}

func deleteTag(doc *tagDoc, id string) {
	i := findTagIndex(doc.Tags, id)
	if i >= 0 {
		doc.Tags = append(doc.Tags[:i], doc.Tags[i+1:]...)
	}
	for taskID, entries := range doc.Tasks {
		kept := entries[:0]
		for _, entry := range entries {
			if entry.TagID != id {
				kept = append(kept, entry)
			}
		}
		if len(kept) == 0 {
			delete(doc.Tasks, taskID)
		} else {
			doc.Tasks[taskID] = kept
		}
	}
}
func removeAgentApplication(doc *tagDoc, taskID, tagID string) {
	entries := doc.Tasks[taskID]
	i := findTaskTagIndex(entries, tagID)
	if i < 0 {
		return
	}
	entries[i].Agent = false
	entries[i].Note = ""
	entries[i].SessionID = ""
	entries[i].UpdatedAt = now()
	if !entries[i].Human {
		entries = append(entries[:i], entries[i+1:]...)
	}
	if len(entries) == 0 {
		delete(doc.Tasks, taskID)
	} else {
		doc.Tasks[taskID] = entries
	}
}
