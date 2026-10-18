/**
 * Her Memory — browser half.
 *
 * Registers the "Memory" settings section and its four in-page tabs. The
 * component never touches the filesystem: every read and write goes through
 * the same-origin plugin API at /plugins/dsh-her-memory/api.
 *
 * Kept as plain browser JavaScript on purpose: React comes from the browser
 * module table, and no Harness Client package is imported. Styles use only
 * --dsw-alias-* theme tokens and are injected once from apply().
 */
window.__ModuleLoader__.load({
	id: "@local/dsh-her-memory",
	factory(require) {
		const React = require("react");
		const { useCallback, useEffect, useRef, useState } = React;
		const h = React.createElement;

		// ── API ────────────────────────────────────────────────────────────
		const API = "/plugins/dsh-her-memory/api";
		const MEMORY_TYPES = ["preference", "event", "emotional", "general"];
		const TAB_KEYS = ["overview", "memories", "curation", "settings"];

		/** Build a transport error that carries the API's stable error shape. */
		function apiError(message, code, status, details) {
			const error = new Error(message || "Request failed");
			error.code = typeof code === "string" && code.length > 0 ? code : "UNKNOWN";
			error.status = typeof status === "number" ? status : 0;
			error.details = details;
			return error;
		}

		async function parseJsonResponse(response) {
			let text = "";
			try {
				text = await response.text();
			} catch (error) {
				return null;
			}
			if (text.length === 0) return null;
			try {
				return JSON.parse(text);
			} catch (error) {
				return null;
			}
		}

		/** POST {action, payload} and unwrap {ok:true,value} or throw the API error. */
		async function call(action, payload, { timeoutMs = 120000 } = {}) {
			const controller = typeof AbortController === "function" ? new AbortController() : null;
			const timer = controller === null ? null : setTimeout(() => controller.abort(), timeoutMs);
			let response;
			try {
				response = await fetch(API, {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json" },
					body: JSON.stringify({ action, payload: payload === undefined ? {} : payload }),
					signal: controller === null ? undefined : controller.signal,
					cache: "no-store",
				});
			} catch (error) {
				if (error && error.name === "AbortError") {
					throw apiError("The request timed out", "TIMEOUT", 0);
				}
				throw apiError(error && error.message ? error.message : "Network request failed", "NETWORK", 0);
			} finally {
				if (timer !== null) clearTimeout(timer);
			}
			const doc = await parseJsonResponse(response);
			if (!response.ok || !doc || doc.ok !== true) {
				const detail = doc && doc.error ? doc.error : null;
				throw apiError(
					detail && detail.message ? detail.message : "HTTP " + response.status,
					detail && detail.code ? detail.code : "UNKNOWN",
					detail && typeof detail.status === "number" ? detail.status : response.status,
					detail ? detail.details : undefined
				);
			}
			return doc.value;
		}

		/** GET the redacted state and unwrap {ok:true,value}. */
		async function loadState() {
			let response;
			try {
				response = await fetch(API, { cache: "no-store", headers: { accept: "application/json" } });
			} catch (error) {
				throw apiError(error && error.message ? error.message : "Network request failed", "NETWORK", 0);
			}
			const doc = await parseJsonResponse(response);
			if (!response.ok || !doc || doc.ok !== true) {
				const detail = doc && doc.error ? doc.error : null;
				throw apiError(
					detail && detail.message ? detail.message : "HTTP " + response.status,
					detail && detail.code ? detail.code : "UNKNOWN",
					detail && typeof detail.status === "number" ? detail.status : response.status,
					detail ? detail.details : undefined
				);
			}
			return doc.value;
		}

		// ── dictionaries ───────────────────────────────────────────────────
		const EN = {
			// Page chrome
			"nav.label": "Memory",
			"page.title": "Memory",
			"page.subtitle": "Persistent companion memory shared by every session.",
			"page.loadError": "Could not load memory state.",
			"page.lastErrorTitle": "Last backend error",
			"page.version": "Plugin {version}",

			// Shared
			"common.loading": "Loading…",
			"common.retry": "Retry",
			"common.all": "All",
			"common.none": "None",
			"common.notAvailable": "—",
			"common.unknown": "Unknown",
			"common.refresh": "Refresh",
			"common.cancel": "Cancel",
			"common.save": "Save",
			"common.saved": "Saved",
			"common.name": "Name",
			"common.description": "Description",
			"common.id": "ID",
			"common.status": "Status",
			"common.warning": "Warning",

			// Tabs
			"tabs.overview": "Overview",
			"tabs.memories": "Memories",
			"tabs.curation": "Curation",
			"tabs.settings": "Settings",

			// Backend status pill
			"status.ready": "Ready",
			"status.degraded": "Degraded",
			"status.keywordOnly": "Keyword-only",
			"status.notConfigured": "Not configured",
			"status.label": "Backend status",
			"status.lastTest": "Last test result",
			"status.neverTested": "Not tested in this session",
			"status.embedding": "Embedding",
			"status.chat": "Chat",
			"status.testOk": "OK",
			"status.testFailed": "Failed",
			"status.testOkWith": "OK · {details}",
			"status.dimensions": "{count} dimensions",
			"status.latency": "{ms} ms",
			"status.notSet": "Not set",
			"status.lastMaintenance": "Last maintenance",
			"status.lastBackfill": "Last backfill",
			"status.lastProposal": "Last proposal",
			"status.never": "Never",
			"status.unknown": "Unknown",

			// Actions
			"actions.refresh": "Refresh",
			"actions.refreshing": "Refreshing…",
			"actions.reloadState": "Reload state",
			"actions.save": "Save",
			"actions.saving": "Saving…",
			"actions.saved": "Saved",
			"actions.cancel": "Cancel",
			"actions.test": "Test connection",
			"actions.testing": "Testing…",
			"actions.runMaintenance": "Run maintenance",
			"actions.running": "Running…",
			"actions.backfillMissing": "Backfill missing",
			"actions.backfillEmbeddings": "Backfill embeddings",
			"actions.backfillAll": "Backfill all",
			"actions.recomputeStamp": "Recompute stamp",
			"actions.compactNow": "Compact now",
			"actions.generateProposal": "Generate proposal",
			"actions.generating": "Generating…",
			"actions.approveExecute": "Approve & execute selected",
			"actions.executing": "Executing…",
			"actions.restore": "Restore snapshot",
			"actions.restoring": "Restoring…",
			"actions.refreshProposals": "Refresh proposals",
			"actions.edit": "Edit",
			"actions.archive": "Archive",
			"actions.delete": "Delete permanently",
			"actions.copy": "Copy",
			"actions.copied": "Copied",
			"actions.copyFailed": "Copy failed",
			"actions.addMemory": "Add memory",
			"actions.search": "Search",
			"actions.clearSearch": "Clear search",
			"actions.previous": "Previous",
			"actions.next": "Next",
			"actions.presetDefaults": "Preset defaults",
			"actions.export": "Export JSONL",
			"actions.exporting": "Exporting…",
			"actions.import": "Import JSONL",
			"actions.importing": "Importing…",
			"actions.chooseFile": "Choose file",
			"actions.clearKey": "Clear key",
			"actions.saveConnection": "Save connection",
			"actions.saveSearch": "Save search defaults",
			"actions.saveMaintenance": "Save maintenance settings",
			"actions.saveConsolidation": "Save consolidation settings",
			"actions.saveStorage": "Save storage settings",
			"actions.saveMemory": "Save memory",

			// Field labels
			"fields.text": "Text",
			"fields.type": "Type",
			"fields.category": "Category",
			"fields.eventDate": "Event date",
			"fields.projectKey": "Project key",
			"fields.dedupe": "Skip duplicates",
			"fields.query": "Search memories",
			"fields.includeArchived": "Include archived",
			"fields.backendKind": "Backend type",
			"fields.embeddingUrl": "Embedding URL",
			"fields.embeddingModel": "Embedding model",
			"fields.embeddingApiKey": "Embedding API key",
			"fields.embeddingTimeout": "Embedding timeout (ms)",
			"fields.chatUrl": "Chat URL",
			"fields.chatModel": "Chat model",
			"fields.chatApiKey": "Chat API key",
			"fields.chatTimeout": "Chat timeout (ms)",
			"fields.defaultTopK": "Default top K",
			"fields.maxTopK": "Maximum top K",
			"fields.minSimilarity": "Minimum similarity",
			"fields.maxResultChars": "Maximum result characters",
			"fields.rrfK": "RRF k",
			"fields.energyDecay": "Energy decay per day",
			"fields.archiveDays": "Archive after (days)",
			"fields.energyMax": "Maximum energy",
			"fields.hitBoost": "Hit boost",
			"fields.triggerCount": "Trigger at (active memories)",
			"fields.triggerSizeMb": "Trigger at (MB)",
			"fields.triggerDays": "Trigger after (days)",
			"fields.similarityPreference": "Preference similarity",
			"fields.similarityEvent": "Event similarity",
			"fields.similarityEmotional": "Emotional similarity",
			"fields.similarityGeneral": "General similarity",
			"fields.llmJudge": "Use LLM judge",
			"fields.memoryDir": "Memory directory",
			"fields.importFile": "JSONL file",
			"fields.fileSize": "File size",
			"fields.invalidNumber": "Enter a valid number.",

			// Placeholders
			"placeholders.query": "Search text, or leave empty to browse",
			"placeholders.text": "What should be remembered?",
			"placeholders.category": "e.g. personal, work, preferences",
			"placeholders.projectKey": "Optional project or repository",
			"placeholders.apiKeyUnchanged": "Unchanged",
			"placeholders.apiKeyEmpty": "No key set",
			"placeholders.memoryDir": "/absolute/path/to/her-memory/memories",

			// Hints
			"hints.apiKey": "Leave blank to keep the stored key. Check “Clear key” to remove it.",
			"hints.memoryDir": "The active, archive, hit, version, snapshot, and proposal files live under this directory. Changing it does not move existing data. You can point it at an existing her.memory directory.",
			"hints.dedupe": "If an equivalent memory already exists, reuse it instead of adding a copy.",
			"hints.editArchived": "Saving archives the previous version and links it to the new one.",
			"hints.delete": "Permanent deletion is available only on this page. The model cannot delete memories.",
			"hints.import": "Imports JSONL lines into the memory directory. Existing IDs are skipped and invalid lines are reported.",
			"hints.export": "Downloads active and archived memories as one JSONL file.",
			"hints.judge": "The judge compares ambiguous pairs. Without a chat backend, proposals contain archive candidates only.",
			"hints.preset": "Fills URLs and models for the selected backend type. Existing model names are kept for OpenAI-style backends.",
			"hints.compaction": "Maintenance physically moves archived entries out of the active JSONL file. Run maintenance, or compact now, to free the space.",

			// Memory types
			"types.preference": "Preference",
			"types.event": "Event",
			"types.emotional": "Emotional",
			"types.general": "General",

			// Overview
			"overview.statsTitle": "Memory store",
			"overview.statActive": "Active",
			"overview.statArchived": "Archived",
			"overview.statPending": "Pending compaction",
			"overview.statTotal": "Total",
			"overview.statFileSize": "File size",
			"overview.statVersion": "Version",
			"overview.statLastMaintenance": "Last maintenance",
			"overview.backendTitle": "Backend",
			"overview.backendDesc": "The embedding backend powers hybrid recall; the chat backend powers the consolidation judge.",
			"overview.kind": "Backend type",
			"overview.embedding": "Embedding",
			"overview.chat": "Chat",
			"overview.model": "Model",
			"overview.url": "URL",
			"overview.notSet": "Not set",
			"overview.lastTest": "Last test result",
			"overview.quickActions": "Quick actions",
			"overview.quickActionsDesc": "These actions run against the live store and report inline.",
			"overview.emptyTitle": "No memories yet",
			"overview.emptyBody": "This store is empty. The model builds it through the her-memory skills and the memory_add, memory_search, memory_update, and memory_archive tools. You can also add a memory on the Memories tab.",
			"overview.lastErrorTitle": "Backend reported an error",
			"result.maintenance": "Maintenance finished: {archived} archived, {boosted} boosted, {decayed} decayed, {moved} compacted.",
			"result.backfill": "Backfill finished: {filled} filled, {skipped} skipped, {failed} failed.",
			"result.stamp": "Version stamp recomputed: {version}.",
			"result.stampPlain": "Version stamp recomputed.",
			"result.embeddingOk": "Embedding backend responded in {ms} ms.",
			"result.chatOk": "Chat backend responded in {ms} ms.",
			"result.testFailed": "The connection test failed. Check the backend settings.",

			// Memories
			"memories.toolbarTitle": "Browse and search",
			"memories.toolbarDesc": "Browse the store page by page, or search the most relevant entries.",
			"memories.addTitle": "Add memory",
			"memories.editTitle": "Edit memory",
			"memories.editFor": "Editing memory {id}",
			"memories.textRequired": "Enter some text to remember.",
			"memories.projectKeyReadOnly": "The project key cannot be changed after creation.",
			"memories.energy": "Energy {value}",
			"memories.lastHit": "Last hit {date}",
			"memories.neverHit": "Never hit",
			"memories.archivedBadge": "Archived",
			"memories.archiveConfirmTitle": "Archive this memory?",
			"memories.archiveConfirm": "The memory leaves active recall. Its history is preserved, and you can find it by including archived memories.",
			"memories.archiveButton": "Archive memory",
			"memories.archivedNotice": "Memory archived.",
			"memories.addedNotice": "Memory added.",
			"memories.updatedNotice": "Memory updated. The previous version is archived and linked.",
			"memories.duplicateNotice": "An equivalent memory already exists ({id}); nothing was added.",
			"memories.noEmbeddingWarning": "The memory was saved without an embedding. It can still be found by keyword; backfill embeddings later.",
			"memories.deleteTitle": "Permanent deletion",
			"memories.deleteWarning": "This permanently removes the active and archived record. Use Archive for a reversible action.",
			"memories.deleteUnderstand": "I understand this cannot be undone",
			"memories.deleteButton": "Delete forever",
			"memories.deletedNotice": "Memory permanently deleted.",
			"memories.deleteOnlyUser": "Only you can delete permanently; the model has no delete tool.",
			"memories.searchNote": "Top {count} results from search (topK {topK}).",
			"memories.searchMode": "Retrieval: {mode}",
			"memories.mode.hybrid": "Hybrid",
			"memories.mode.keyword": "Keyword-only",
			"memories.mode.empty": "No retrieval",
			"memories.resultCount": "{count} memories",
			"memories.resultCountOne": "1 memory",
			"memories.pageOf": "Page {page} of {pages}",
			"memories.totalCount": "{count} total",
			"memories.empty": "No memories yet. Add one, or let the model capture one through memory_add.",
			"memories.emptyFiltered": "No memories match these filters.",
			"memories.emptySearch": "No memories match this search.",
			"memories.loadError": "Could not load memories.",
			"memories.idLabel": "ID",
			"memories.warnings": "Warnings",
			"memories.pagination": "Memory pages",
			"memories.newestFirst": "Newest first",
			"memories.searchTopKNote": "Search returns up to {topK} entries and is not paginated.",
			"memories.copyId": "Copy memory ID {id}",

			// Curation
			"curation.maintenanceTitle": "Maintenance",
			"curation.maintenanceDesc": "Energy and age decide what stays active. Maintenance applies decay, boosts recently hit memories, and archives memories by age.",
			"curation.pendingCompaction": "Pending compaction: {count}",
			"curation.runMaintenance": "Run maintenance",
			"curation.backfillMissing": "Backfill missing",
			"curation.backfillAll": "Backfill all",
			"curation.recomputeStamp": "Recompute stamp",
			"curation.compactNow": "Compact now",
			"curation.consolidationTitle": "Consolidation",
			"curation.consolidationDesc": "Proposals group related memories, suggest merges, and archive stale entries. Review everything before executing.",
			"curation.similarityTitle": "Per-type similarity thresholds",
			"curation.llmJudge": "Use LLM judge",
			"curation.judgeUnavailable": "LLM judge is enabled, but no chat backend is configured. Proposals will contain archive candidates only.",
			"curation.generate": "Generate proposal",
			"curation.generating": "Generating proposal…",
			"curation.generatedNotice": "Proposal {id} generated.",
			"curation.proposalsTitle": "Proposals",
			"curation.proposalCount": "{count} proposals",
			"curation.proposalLine": "{id} · {status} · {date}",
			"curation.countsLine": "{merge} merge groups, {archive} archive candidates, {skill} skill candidates",
			"curation.status.pending_review": "Pending review",
			"curation.status.executed": "Executed",
			"curation.status.restored": "Restored",
			"curation.detailTitle": "Proposal {id}",
			"curation.trigger": "Trigger",
			"curation.generatedAt": "Generated {date}",
			"curation.currentStats": "Current stats",
			"curation.activeCount": "Active: {count}",
			"curation.fileSizeMb": "File size: {size} MB",
			"curation.byType": "By type",
			"curation.mergeGroups": "Merge groups",
			"curation.group": "Group {id}",
			"curation.includeGroup": "Include group {id}",
			"curation.mergedText": "Merged text",
			"curation.similarity": "Similarity {value}",
			"curation.members": "Members",
			"curation.memberMeta": "{type} · energy {energy}",
			"curation.archiveCandidates": "Archive candidates",
			"curation.includeArchive": "Archive {id}",
			"curation.archiveReason": "Reason: {reason}",
			"curation.skillCandidates": "Skill candidates",
			"curation.noSkillCandidates": "No skill candidates.",
			"curation.approve": "Approve & execute selected",
			"curation.restore": "Restore snapshot",
			"curation.confirmExecute": "Execute the selected merge groups and archive candidates? A snapshot is taken first so you can restore.",
			"curation.confirmRestore": "Restore the pre-execution snapshot and undo this proposal's changes?",
			"curation.executedResult": "Executed: {merged} groups merged, {archived} memories archived.",
			"curation.restoredResult": "Snapshot restored.",
			"curation.noProposalSelected": "Select a proposal to review it.",
			"curation.snapshotHint": "Restore is available only after the proposal has been executed.",
			"curation.nothingSelected": "Select at least one merge group or archive candidate.",
			"curation.noProposals": "No proposals yet. Generate one when there are enough active memories.",
			"curation.unknownCount": "—",
			"curation.proposalLoadError": "Could not load the proposal.",
			"curation.listLoadError": "Could not load proposals.",

			// Settings
			"settings.connectionTitle": "Connection",
			"settings.connectionDesc": "Embedding and chat backends. Keys stay in the plugin config and are never returned to this page.",
			"settings.kind.ollama": "Ollama",
			"settings.kind.llama-cpp": "llama.cpp",
			"settings.kind.openai-compatible": "OpenAI-compatible",
			"settings.kind.none": "None (keyword-only)",
			"settings.embeddingSection": "Embeddings",
			"settings.chatSection": "Chat",
			"settings.testResult": "Test result",
			"settings.connectionSaved": "Connection settings saved.",
			"settings.keyClearedNotice": "Stored key cleared.",
			"settings.searchTitle": "Search defaults",
			"settings.searchDesc": "Defaults for model search calls and the Memories tab.",
			"settings.searchSaved": "Search defaults saved.",
			"settings.maintenanceSaved": "Maintenance settings saved.",
			"settings.consolidationSaved": "Consolidation settings saved.",
			"settings.storageTitle": "Storage",
			"settings.storageDesc": "The store is a directory of human-readable JSONL files.",
			"settings.homePath": "Plugin home",
			"settings.pathsTitle": "Derived paths",
			"settings.activeFile": "Active file",
			"settings.archiveFile": "Archive file",
			"settings.hitFile": "Hit log",
			"settings.versionFile": "Version stamp",
			"settings.snapshotsDir": "Snapshots",
			"settings.proposalsDir": "Proposals",
			"settings.storageSaved": "Storage settings saved.",
			"settings.exportTitle": "Export",
			"settings.exportDesc": "Download active and archived memories as one JSONL file.",
			"settings.exportEmpty": "There are no memories to export.",
			"settings.importTitle": "Import",
			"settings.importPreview": "{name}: {count} non-empty lines selected.",
			"settings.importBackfill": "Backfill embeddings after import",
			"settings.importResult": "Imported {imported}, skipped {skipped}, invalid {invalid}, embeddings filled {filled}.",
			"settings.importNoFile": "Choose a JSONL file first.",
			"settings.importConfirm": "Import these {count} lines into the memory store?",
			"settings.exportDone": "Export downloaded.",
			"settings.aboutTitle": "About",
			"settings.aboutPlugin": "Plugin",
			"settings.aboutVersion": "Version",
			"settings.aboutLink": "her.memory on GitHub",
			"settings.aboutLicense": "MIT licensed. The design follows her.memory; see THIRD_PARTY_NOTICES.md in the plugin package.",
			"settings.aboutSkills": "Registered skills",
			"settings.aboutTools": "Model tools",
			"settings.aboutFormat": "Format",
			"settings.aboutFormatText": "Each memory is one JSON line with an ID, text, type, category, timestamp, energy, hit time, and optional embedding, event date, project key, and supersede or merge links.",
			"settings.aboutCapabilities": "Capabilities",
			"settings.capabilitySkills": "Skills",
			"settings.capabilityPrompt": "System prompt section",
			"settings.capabilityWebApi": "Web API",
			"settings.enabled": "Enabled",
			"settings.disabled": "Disabled",
			"settings.noSkills": "No skills are registered in this composition.",
			"settings.noTools": "No tools are registered in this composition.",

			// Empty states
			"empty.memoriesTitle": "Start the memory",
			"empty.memoriesBody": "There is nothing here yet. Ask the agent to remember something, or add a memory yourself on the Memories tab.",
			"empty.proposals": "No proposals yet. Generate one when there are enough active memories.",
			"empty.skills": "No skills are registered in this composition.",

			// Confirmation
			"confirm.archive": "Archive this memory? It leaves active recall, and its full history is kept.",
			"confirm.archiveButton": "Archive memory",
			"confirm.delete": "Permanently delete this memory? This cannot be undone.",
			"confirm.deleteButton": "Delete forever",
			"confirm.execute": "Execute the selected merge groups and archive candidates? A snapshot is taken first so you can restore.",
			"confirm.restore": "Restore the pre-execution snapshot and undo this proposal's changes?",
			"confirm.import": "Import these {count} lines into the memory store?",

			// ARIA
			"aria.tabs": "Memory settings sections",
			"aria.status": "Backend status: {status}",
			"aria.copy": "Copy {label}",
			"aria.saveCard": "Save {card}",
			"aria.testConnection": "Test the embedding and chat connections",
			"aria.refresh": "Refresh memory state",
			"aria.confirm": "Confirmation",
			"aria.pagination": "Memory pages",
			"aria.searchResults": "Memory results",
			"aria.addForm": "Add a memory",
			"aria.editForm": "Edit a memory",
			"aria.includeGroup": "Include merge group {id}",
			"aria.includeArchive": "Include archive candidate {id}",
			"aria.skillList": "Skill candidates",
			"aria.pathList": "Memory file paths",

			// Errors
			"errors.INVALID_INPUT": "Some input is invalid. Check the values and try again.",
			"errors.STORE_LOCKED": "The memory store is locked by another process. Try again in a moment.",
			"errors.STORE_IO": "The memory files could not be read or written. Check the storage paths and permissions.",
			"errors.NOT_FOUND": "The requested memory was not found.",
			"errors.DUPLICATE": "An equivalent memory already exists.",
			"errors.BACKEND_UNAVAILABLE": "The embedding or chat backend is unavailable. Check the connection settings.",
			"errors.EMBEDDING_FAILED": "The embedding request failed. Keyword search still works.",
			"errors.CHAT_FAILED": "The chat request failed.",
			"errors.PROPOSAL_NOT_FOUND": "That proposal was not found.",
			"errors.PROPOSAL_NOT_EXECUTED": "That proposal has not been executed, so it cannot be restored.",
			"errors.SNAPSHOT_NOT_FOUND": "The snapshot for that proposal was not found.",
			"errors.IMPORT_INVALID": "The import file is not valid JSONL, or it contains no usable memories.",
			"errors.EXPORT_TOO_LARGE": "The memory store is too large to export in one download.",
			"errors.NETWORK": "Could not reach the plugin API.",
			"errors.TIMEOUT": "The request timed out. The operation may still be running.",
			"errors.UNKNOWN": "Something went wrong.",
		};

		const ZH = {
			// Page chrome
			"nav.label": "记忆",
			"page.title": "记忆",
			"page.subtitle": "所有会话共享的持久化陪伴记忆。",
			"page.loadError": "无法加载记忆状态。",
			"page.lastErrorTitle": "最近一次后端错误",
			"page.version": "插件版本 {version}",

			// Shared
			"common.loading": "加载中…",
			"common.retry": "重试",
			"common.all": "全部",
			"common.none": "无",
			"common.notAvailable": "—",
			"common.unknown": "未知",
			"common.refresh": "刷新",
			"common.cancel": "取消",
			"common.save": "保存",
			"common.saved": "已保存",
			"common.name": "名称",
			"common.description": "说明",
			"common.id": "ID",
			"common.status": "状态",
			"common.warning": "警告",

			// Tabs
			"tabs.overview": "概览",
			"tabs.memories": "记忆",
			"tabs.curation": "整理",
			"tabs.settings": "设置",

			// Backend status pill
			"status.ready": "就绪",
			"status.degraded": "降级",
			"status.keywordOnly": "仅关键词",
			"status.notConfigured": "未配置",
			"status.label": "后端状态",
			"status.lastTest": "最近测试结果",
			"status.neverTested": "本次会话尚未测试",
			"status.embedding": "嵌入",
			"status.chat": "对话",
			"status.testOk": "正常",
			"status.testFailed": "失败",
			"status.testOkWith": "正常 · {details}",
			"status.dimensions": "{count} 维",
			"status.latency": "{ms} 毫秒",
			"status.notSet": "未设置",
			"status.lastMaintenance": "最近维护",
			"status.lastBackfill": "最近回填",
			"status.lastProposal": "最近提案",
			"status.never": "从未",
			"status.unknown": "未知",

			// Actions
			"actions.refresh": "刷新",
			"actions.refreshing": "正在刷新…",
			"actions.reloadState": "重新加载状态",
			"actions.save": "保存",
			"actions.saving": "正在保存…",
			"actions.saved": "已保存",
			"actions.cancel": "取消",
			"actions.test": "测试连接",
			"actions.testing": "正在测试…",
			"actions.runMaintenance": "运行维护",
			"actions.running": "正在运行…",
			"actions.backfillMissing": "回填缺失",
			"actions.backfillEmbeddings": "回填嵌入",
			"actions.backfillAll": "回填全部",
			"actions.recomputeStamp": "重算版本戳",
			"actions.compactNow": "立即压实",
			"actions.generateProposal": "生成提案",
			"actions.generating": "正在生成提案…",
			"actions.approveExecute": "批准并执行所选",
			"actions.executing": "正在执行…",
			"actions.restore": "恢复快照",
			"actions.restoring": "正在恢复…",
			"actions.refreshProposals": "刷新提案",
			"actions.edit": "编辑",
			"actions.archive": "归档",
			"actions.delete": "永久删除",
			"actions.copy": "复制",
			"actions.copied": "已复制",
			"actions.copyFailed": "复制失败",
			"actions.addMemory": "添加记忆",
			"actions.search": "搜索",
			"actions.clearSearch": "清除搜索",
			"actions.previous": "上一页",
			"actions.next": "下一页",
			"actions.presetDefaults": "填入预设",
			"actions.export": "导出 JSONL",
			"actions.exporting": "正在导出…",
			"actions.import": "导入 JSONL",
			"actions.importing": "正在导入…",
			"actions.chooseFile": "选择文件",
			"actions.clearKey": "清除密钥",
			"actions.saveConnection": "保存连接设置",
			"actions.saveSearch": "保存搜索默认值",
			"actions.saveMaintenance": "保存维护设置",
			"actions.saveConsolidation": "保存整理设置",
			"actions.saveStorage": "保存存储设置",
			"actions.saveMemory": "保存记忆",

			// Field labels
			"fields.text": "内容",
			"fields.type": "类型",
			"fields.category": "分类",
			"fields.eventDate": "事件日期",
			"fields.projectKey": "项目键",
			"fields.dedupe": "跳过重复项",
			"fields.query": "搜索记忆",
			"fields.includeArchived": "包含已归档",
			"fields.backendKind": "后端类型",
			"fields.embeddingUrl": "嵌入 URL",
			"fields.embeddingModel": "嵌入模型",
			"fields.embeddingApiKey": "嵌入 API 密钥",
			"fields.embeddingTimeout": "嵌入超时（毫秒）",
			"fields.chatUrl": "对话 URL",
			"fields.chatModel": "对话模型",
			"fields.chatApiKey": "对话 API 密钥",
			"fields.chatTimeout": "对话超时（毫秒）",
			"fields.defaultTopK": "默认 top K",
			"fields.maxTopK": "最大 top K",
			"fields.minSimilarity": "最低相似度",
			"fields.maxResultChars": "结果最大字符数",
			"fields.rrfK": "RRF k",
			"fields.energyDecay": "每日能量衰减",
			"fields.archiveDays": "归档期限（天）",
			"fields.energyMax": "最大能量",
			"fields.hitBoost": "命中加成",
			"fields.triggerCount": "触发阈值（活跃记忆数）",
			"fields.triggerSizeMb": "触发阈值（MB）",
			"fields.triggerDays": "触发期限（天）",
			"fields.similarityPreference": "偏好类相似度",
			"fields.similarityEvent": "事件类相似度",
			"fields.similarityEmotional": "情感类相似度",
			"fields.similarityGeneral": "通用类相似度",
			"fields.llmJudge": "使用 LLM 判断",
			"fields.memoryDir": "记忆目录",
			"fields.importFile": "JSONL 文件",
			"fields.fileSize": "文件大小",
			"fields.invalidNumber": "请输入有效数字。",

			// Placeholders
			"placeholders.query": "输入搜索文字，留空则浏览",
			"placeholders.text": "想记住什么？",
			"placeholders.category": "例如：个人、工作、偏好",
			"placeholders.projectKey": "可选：项目或仓库",
			"placeholders.apiKeyUnchanged": "保持不变",
			"placeholders.apiKeyEmpty": "未设置密钥",
			"placeholders.memoryDir": "/absolute/path/to/her-memory/memories",

			// Hints
			"hints.apiKey": "留空表示保留已存储的密钥。勾选“清除密钥”可删除它。",
			"hints.memoryDir": "活跃、归档、命中、版本、快照和提案文件都位于此目录下。修改目录不会移动现有数据；也可以指向已有的 her.memory 目录。",
			"hints.dedupe": "如果已存在等价记忆，则直接复用它，不再新增副本。",
			"hints.editArchived": "保存后旧版本会被归档，并与新版本建立关联。",
			"hints.delete": "永久删除仅在此页面提供，模型没有删除工具。",
			"hints.import": "将 JSONL 行导入记忆目录。已存在的 ID 会被跳过，无效行会被报告。",
			"hints.export": "将活跃和已归档记忆导出为同一个 JSONL 文件。",
			"hints.judge": "LLM 判断会比较高相似度的记忆对。未配置对话后端时，提案只包含归档候选。",
			"hints.preset": "为所选后端类型填入 URL 和模型。OpenAI 风格的后端会保留现有模型名。",
			"hints.compaction": "维护会把已归档条目从活跃 JSONL 文件中真正移出。运行维护或立即压实即可释放空间。",

			// Memory types
			"types.preference": "偏好",
			"types.event": "事件",
			"types.emotional": "情感",
			"types.general": "通用",

			// Overview
			"overview.statsTitle": "记忆存储",
			"overview.statActive": "活跃",
			"overview.statArchived": "已归档",
			"overview.statPending": "待压实",
			"overview.statTotal": "总计",
			"overview.statFileSize": "文件大小",
			"overview.statVersion": "版本",
			"overview.statLastMaintenance": "最近维护",
			"overview.backendTitle": "后端",
			"overview.backendDesc": "嵌入后端驱动混合检索；对话后端驱动整理判断。",
			"overview.kind": "后端类型",
			"overview.embedding": "嵌入",
			"overview.chat": "对话",
			"overview.model": "模型",
			"overview.url": "URL",
			"overview.notSet": "未设置",
			"overview.lastTest": "最近测试结果",
			"overview.quickActions": "快捷操作",
			"overview.quickActionsDesc": "这些操作直接作用于当前存储，并在下方就地反馈。",
			"overview.emptyTitle": "还没有记忆",
			"overview.emptyBody": "存储目前为空。模型会通过 her-memory 技能以及 memory_add、memory_search、memory_update、memory_archive 工具逐步建立记忆；你也可以在“记忆”页手动添加。",
			"overview.lastErrorTitle": "后端报告错误",
			"result.maintenance": "维护完成：归档 {archived} 条，加成 {boosted} 条，衰减 {decayed} 条，压实 {moved} 条。",
			"result.backfill": "回填完成：填充 {filled} 条，跳过 {skipped} 条，失败 {failed} 条。",
			"result.stamp": "版本戳已重算：{version}。",
			"result.stampPlain": "版本戳已重算。",
			"result.embeddingOk": "嵌入后端在 {ms} 毫秒内响应。",
			"result.chatOk": "对话后端在 {ms} 毫秒内响应。",
			"result.testFailed": "连接测试失败，请检查后端设置。",

			// Memories
			"memories.toolbarTitle": "浏览与搜索",
			"memories.toolbarDesc": "逐页浏览存储，或搜索最相关的条目。",
			"memories.addTitle": "添加记忆",
			"memories.editTitle": "编辑记忆",
			"memories.editFor": "正在编辑记忆 {id}",
			"memories.textRequired": "请输入要记住的内容。",
			"memories.projectKeyReadOnly": "创建后不能修改项目键。",
			"memories.energy": "能量 {value}",
			"memories.lastHit": "最近命中 {date}",
			"memories.neverHit": "从未命中",
			"memories.archivedBadge": "已归档",
			"memories.archiveConfirmTitle": "归档这条记忆？",
			"memories.archiveConfirm": "该记忆将退出活跃召回。完整历史仍会保留，勾选包含已归档即可找到它。",
			"memories.archiveButton": "归档记忆",
			"memories.archivedNotice": "记忆已归档。",
			"memories.addedNotice": "记忆已添加。",
			"memories.updatedNotice": "记忆已更新。旧版本已归档并与新版本关联。",
			"memories.duplicateNotice": "已存在等价记忆（{id}），未新增。",
			"memories.noEmbeddingWarning": "记忆已保存但没有嵌入向量，仍可通过关键词找到；之后可回填嵌入。",
			"memories.deleteTitle": "永久删除",
			"memories.deleteWarning": "这会永久移除活跃和归档记录。若想可恢复，请使用归档。",
			"memories.deleteUnderstand": "我明白此操作无法撤销",
			"memories.deleteButton": "永久删除",
			"memories.deletedNotice": "记忆已永久删除。",
			"memories.deleteOnlyUser": "只有你可以永久删除；模型没有删除工具。",
			"memories.searchNote": "显示前 {count} 条搜索结果（topK {topK}）。",
			"memories.searchMode": "检索方式：{mode}",
			"memories.mode.hybrid": "混合",
			"memories.mode.keyword": "仅关键词",
			"memories.mode.empty": "无检索",
			"memories.resultCount": "{count} 条记忆",
			"memories.resultCountOne": "1 条记忆",
			"memories.pageOf": "第 {page} 页，共 {pages} 页",
			"memories.totalCount": "共 {count} 条",
			"memories.empty": "还没有记忆。可以手动添加，或让模型通过 memory_add 记录。",
			"memories.emptyFiltered": "没有符合这些筛选条件的记忆。",
			"memories.emptySearch": "没有匹配此搜索的记忆。",
			"memories.loadError": "无法加载记忆。",
			"memories.idLabel": "ID",
			"memories.warnings": "警告",
			"memories.pagination": "记忆分页",
			"memories.newestFirst": "最新在前",
			"memories.searchTopKNote": "搜索最多返回 {topK} 条，不分页。",
			"memories.copyId": "复制记忆 ID {id}",

			// Curation
			"curation.maintenanceTitle": "维护",
			"curation.maintenanceDesc": "能量和时效决定哪些记忆保持活跃。维护会应用衰减、加成最近命中的记忆，并按时间归档。",
			"curation.pendingCompaction": "待压实：{count} 条",
			"curation.runMaintenance": "运行维护",
			"curation.backfillMissing": "回填缺失",
			"curation.backfillAll": "回填全部",
			"curation.recomputeStamp": "重算版本戳",
			"curation.compactNow": "立即压实",
			"curation.consolidationTitle": "整理",
			"curation.consolidationDesc": "提案会把相关记忆分组、建议合并并归档陈旧条目。执行前请逐项检查。",
			"curation.similarityTitle": "各类型相似度阈值",
			"curation.llmJudge": "使用 LLM 判断",
			"curation.judgeUnavailable": "已启用 LLM 判断，但没有配置对话后端。提案将只包含归档候选。",
			"curation.generate": "生成提案",
			"curation.generating": "正在生成提案…",
			"curation.generatedNotice": "提案 {id} 已生成。",
			"curation.proposalsTitle": "提案",
			"curation.proposalCount": "{count} 个提案",
			"curation.proposalLine": "{id} · {status} · {date}",
			"curation.countsLine": "{merge} 个合并组，{archive} 个归档候选，{skill} 个技能候选",
			"curation.status.pending_review": "待审核",
			"curation.status.executed": "已执行",
			"curation.status.restored": "已恢复",
			"curation.detailTitle": "提案 {id}",
			"curation.trigger": "触发原因",
			"curation.generatedAt": "生成于 {date}",
			"curation.currentStats": "当前统计",
			"curation.activeCount": "活跃：{count} 条",
			"curation.fileSizeMb": "文件大小：{size} MB",
			"curation.byType": "按类型",
			"curation.mergeGroups": "合并组",
			"curation.group": "组 {id}",
			"curation.includeGroup": "包含组 {id}",
			"curation.mergedText": "合并后内容",
			"curation.similarity": "相似度 {value}",
			"curation.members": "成员",
			"curation.memberMeta": "{type} · 能量 {energy}",
			"curation.archiveCandidates": "归档候选",
			"curation.includeArchive": "归档 {id}",
			"curation.archiveReason": "原因：{reason}",
			"curation.skillCandidates": "技能候选",
			"curation.noSkillCandidates": "没有技能候选。",
			"curation.approve": "批准并执行所选",
			"curation.restore": "恢复快照",
			"curation.confirmExecute": "执行所选的合并组和归档候选？执行前会先创建快照，便于恢复。",
			"curation.confirmRestore": "恢复执行前的快照并撤销此提案的改动？",
			"curation.executedResult": "已执行：合并 {merged} 组，归档 {archived} 条记忆。",
			"curation.restoredResult": "快照已恢复。",
			"curation.noProposalSelected": "选择一个提案进行审阅。",
			"curation.snapshotHint": "只有已执行的提案才能恢复。",
			"curation.nothingSelected": "请至少选择一个合并组或归档候选。",
			"curation.noProposals": "还没有提案。活跃记忆足够多时可以生成一个。",
			"curation.unknownCount": "—",
			"curation.proposalLoadError": "无法加载该提案。",
			"curation.listLoadError": "无法加载提案列表。",

			// Settings
			"settings.connectionTitle": "连接",
			"settings.connectionDesc": "嵌入与对话后端。密钥保存在插件配置中，不会返回给此页面。",
			"settings.kind.ollama": "Ollama",
			"settings.kind.llama-cpp": "llama.cpp",
			"settings.kind.openai-compatible": "OpenAI 兼容",
			"settings.kind.none": "无（仅关键词）",
			"settings.embeddingSection": "嵌入",
			"settings.chatSection": "对话",
			"settings.testResult": "测试结果",
			"settings.connectionSaved": "连接设置已保存。",
			"settings.keyClearedNotice": "已清除存储的密钥。",
			"settings.searchTitle": "搜索默认值",
			"settings.searchDesc": "模型搜索调用和“记忆”页使用的默认值。",
			"settings.searchSaved": "搜索默认值已保存。",
			"settings.maintenanceSaved": "维护设置已保存。",
			"settings.consolidationSaved": "整理设置已保存。",
			"settings.storageTitle": "存储",
			"settings.storageDesc": "存储目录由人类可读的 JSONL 文件组成。",
			"settings.homePath": "插件主目录",
			"settings.pathsTitle": "派生路径",
			"settings.activeFile": "活跃文件",
			"settings.archiveFile": "归档文件",
			"settings.hitFile": "命中日志",
			"settings.versionFile": "版本戳",
			"settings.snapshotsDir": "快照目录",
			"settings.proposalsDir": "提案目录",
			"settings.storageSaved": "存储设置已保存。",
			"settings.exportTitle": "导出",
			"settings.exportDesc": "将活跃和已归档记忆下载为同一个 JSONL 文件。",
			"settings.exportEmpty": "没有可导出的记忆。",
			"settings.importTitle": "导入",
			"settings.importPreview": "{name}：已选择 {count} 个非空行。",
			"settings.importBackfill": "导入后回填嵌入",
			"settings.importResult": "已导入 {imported} 条，跳过 {skipped} 条，无效 {invalid} 条，填充嵌入 {filled} 条。",
			"settings.importNoFile": "请先选择 JSONL 文件。",
			"settings.importConfirm": "将这 {count} 行导入记忆存储？",
			"settings.exportDone": "导出已开始下载。",
			"settings.aboutTitle": "关于",
			"settings.aboutPlugin": "插件",
			"settings.aboutVersion": "版本",
			"settings.aboutLink": "GitHub 上的 her.memory",
			"settings.aboutLicense": "MIT 许可。设计遵循 her.memory；详见插件包中的 THIRD_PARTY_NOTICES.md。",
			"settings.aboutSkills": "已注册技能",
			"settings.aboutTools": "模型工具",
			"settings.aboutFormat": "格式",
			"settings.aboutFormatText": "每条记忆是一行 JSON，包含 ID、内容、类型、分类、时间戳、能量、命中时间，以及可选的嵌入、事件日期、项目键和取代或合并关联。",
			"settings.aboutCapabilities": "能力",
			"settings.capabilitySkills": "技能",
			"settings.capabilityPrompt": "系统提示片段",
			"settings.capabilityWebApi": "Web API",
			"settings.enabled": "已启用",
			"settings.disabled": "未启用",
			"settings.noSkills": "此组合中没有注册技能。",
			"settings.noTools": "此组合中没有注册工具。",

			// Empty states
			"empty.memoriesTitle": "开始积累记忆",
			"empty.memoriesBody": "这里还没有内容。让智能体记住一些事情，或在“记忆”页手动添加。",
			"empty.proposals": "还没有提案。活跃记忆足够多时可以生成一个。",
			"empty.skills": "此组合中没有注册技能。",

			// Confirmation
			"confirm.archive": "归档这条记忆？它会退出活跃召回，完整历史仍会保留。",
			"confirm.archiveButton": "归档记忆",
			"confirm.delete": "永久删除这条记忆？此操作无法撤销。",
			"confirm.deleteButton": "永久删除",
			"confirm.execute": "执行所选的合并组和归档候选？执行前会先创建快照，便于恢复。",
			"confirm.restore": "恢复执行前的快照并撤销此提案的改动？",
			"confirm.import": "将这 {count} 行导入记忆存储？",

			// ARIA
			"aria.tabs": "记忆设置分区",
			"aria.status": "后端状态：{status}",
			"aria.copy": "复制{label}",
			"aria.saveCard": "保存{card}",
			"aria.testConnection": "测试嵌入和对话连接",
			"aria.refresh": "刷新记忆状态",
			"aria.confirm": "确认操作",
			"aria.pagination": "记忆分页",
			"aria.searchResults": "记忆结果",
			"aria.addForm": "添加记忆",
			"aria.editForm": "编辑记忆",
			"aria.includeGroup": "包含合并组 {id}",
			"aria.includeArchive": "包含归档候选 {id}",
			"aria.skillList": "技能候选",
			"aria.pathList": "记忆文件路径",

			// Errors
			"errors.INVALID_INPUT": "输入有误，请检查后重试。",
			"errors.STORE_LOCKED": "记忆存储被另一个进程锁定，请稍后重试。",
			"errors.STORE_IO": "无法读写记忆文件，请检查存储路径和权限。",
			"errors.NOT_FOUND": "未找到请求的记忆。",
			"errors.DUPLICATE": "已存在等价的记忆。",
			"errors.BACKEND_UNAVAILABLE": "嵌入或对话后端不可用，请检查连接设置。",
			"errors.EMBEDDING_FAILED": "嵌入请求失败。关键词搜索仍然可用。",
			"errors.CHAT_FAILED": "对话请求失败。",
			"errors.PROPOSAL_NOT_FOUND": "未找到该提案。",
			"errors.PROPOSAL_NOT_EXECUTED": "该提案尚未执行，无法恢复。",
			"errors.SNAPSHOT_NOT_FOUND": "未找到该提案的快照。",
			"errors.IMPORT_INVALID": "导入文件不是有效的 JSONL，或不包含可用记忆。",
			"errors.EXPORT_TOO_LARGE": "记忆存储过大，无法一次导出。",
			"errors.NETWORK": "无法连接插件 API。",
			"errors.TIMEOUT": "请求超时，操作可能仍在进行。",
			"errors.UNKNOWN": "发生未知错误。",
		};

		/** Translate an API error, preferring a dictionary entry for its code. */
		function errorText(t, error) {
			const code = error && typeof error.code === "string" && error.code.length > 0 ? error.code : "UNKNOWN";
			const key = "errors." + code;
			if (Object.prototype.hasOwnProperty.call(EN, key)) return t(key);
			return error && error.message ? String(error.message) : t("errors.UNKNOWN");
		}

		/** Raw message when it adds detail beyond the localized sentence. */
		function errorDetail(t, error) {
			if (!error || !error.message) return "";
			const localized = errorText(t, error);
			const raw = String(error.message);
			return raw === localized ? "" : raw;
		}

		// ── formatting ─────────────────────────────────────────────────────
		function activeLang() {
			const lang = typeof document !== "undefined" && document.documentElement ? document.documentElement.lang : "";
			return typeof lang === "string" && lang.length > 0 ? lang : "en";
		}

		function formatDate(value, withTime) {
			if (value === null || value === undefined || value === "") return "";
			const date = new Date(value);
			if (Number.isNaN(date.getTime())) return String(value);
			const options = withTime === false ? { dateStyle: "medium" } : { dateStyle: "medium", timeStyle: "short" };
			try {
				return date.toLocaleString(activeLang(), options);
			} catch (error) {
				return date.toISOString();
			}
		}

		function formatNumber(value, digits) {
			if (value === null || value === undefined || value === "") return "—";
			const number = Number(value);
			if (!Number.isFinite(number)) return String(value);
			try {
				return number.toLocaleString(activeLang(), {
					minimumFractionDigits: digits === undefined ? 0 : digits,
					maximumFractionDigits: digits === undefined ? 2 : digits,
				});
			} catch (error) {
				return String(number);
			}
		}

		function formatBytes(bytes) {
			if (bytes === null || bytes === undefined || bytes === "") return "—";
			const number = Number(bytes);
			if (!Number.isFinite(number) || number < 0) return "—";
			const units = ["byte", "kilobyte", "megabyte", "gigabyte"];
			let value = number;
			let unit = 0;
			while (value >= 1024 && unit < units.length - 1) {
				value /= 1024;
				unit += 1;
			}
			const digits = value >= 10 || unit === 0 ? 0 : 1;
			try {
				return new Intl.NumberFormat(activeLang(), {
					style: "unit",
					unit: units[unit],
					unitDisplay: "short",
					maximumFractionDigits: digits,
				}).format(value);
			} catch (error) {
				return formatNumber(value, digits) + " " + units[unit];
			}
		}

		function formatCount(value) {
			if (value === null || value === undefined || value === "") return "—";
			const number = Number(value);
			if (!Number.isFinite(number)) return String(value);
			try {
				return new Intl.NumberFormat(activeLang()).format(number);
			} catch (error) {
				return String(number);
			}
		}

		function shortId(value) {
			const text = value === null || value === undefined ? "" : String(value);
			return text.length > 12 ? text.slice(0, 8) + "…" : text;
		}

		// ── styles ─────────────────────────────────────────────────────────
		const CSS = `
.dsh-hm-root{display:flex;flex-direction:column;gap:16px;width:100%;max-width:100%;min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.dsh-hm-root *,.dsh-hm-root *::before,.dsh-hm-root *::after{box-sizing:border-box}
.dsh-hm-root :focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dsh-hm-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;min-width:0}
.dsh-hm-heading{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsh-hm-title{margin:0;font-size:16px;line-height:24px;font-weight:600;overflow-wrap:anywhere}
.dsh-hm-subtitle{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);max-width:60ch}
.dsh-hm-header-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-hm-pill{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:3px 10px;font-size:12px;line-height:16px;background:var(--dsw-alias-bg-layer-1);white-space:nowrap}
.dsh-hm-pill-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.dsh-hm-pill[data-state="ready"]{color:var(--dsw-alias-state-success-primary)}
.dsh-hm-pill[data-state="degraded"]{color:var(--dsw-alias-state-warn-primary)}
.dsh-hm-pill[data-state="keywordOnly"]{color:var(--dsw-alias-state-idle-primary)}
.dsh-hm-pill[data-state="notConfigured"]{color:var(--dsw-alias-label-secondary)}
.dsh-hm-pill[data-state="unknown"]{color:var(--dsw-alias-label-secondary)}
.dsh-hm-banner{display:flex;flex-direction:column;gap:2px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:var(--dsw-radius-sm);padding:8px 12px;background:var(--dsw-alias-bg-layer-1);min-width:0}
.dsh-hm-banner-title{font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-state-error-primary)}
.dsh-hm-banner-text{font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dsh-hm-tabs{display:flex;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
.dsh-hm-tab{appearance:none;border:none;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;padding:8px 12px;border-radius:var(--dsw-radius-sm) var(--dsw-radius-sm) 0 0;cursor:pointer;white-space:nowrap}
.dsh-hm-tab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-hm-tab[aria-selected="true"]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:600}
.dsh-hm-panel{display:flex;flex-direction:column;gap:16px;min-width:0}
.dsh-hm-panel[hidden]{display:none}
.dsh-hm-card{display:flex;flex-direction:column;gap:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);padding:16px;min-width:0}
.dsh-hm-card-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;min-width:0}
.dsh-hm-card-heading{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsh-hm-card-title{margin:0;font-size:14px;line-height:22px;font-weight:600;overflow-wrap:anywhere}
.dsh-hm-card-desc{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsh-hm-card-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-hm-card-body{display:flex;flex-direction:column;gap:12px;min-width:0}
.dsh-hm-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.dsh-hm-actions-end{justify-content:flex-end}
.dsh-hm-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:30px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px;padding:6px 12px;cursor:pointer;text-align:center;white-space:normal;overflow-wrap:anywhere}
.dsh-hm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-hm-btn:disabled{opacity:.55;cursor:not-allowed}
.dsh-hm-btn-primary{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground)}
.dsh-hm-btn-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary);opacity:.9}
.dsh-hm-btn-danger{border-color:currentColor;background:transparent;color:var(--dsw-alias-state-error-primary)}
.dsh-hm-btn-ghost{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary)}
.dsh-hm-btn-ghost:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.dsh-hm-spinner{display:inline-block;width:12px;height:12px;flex:none;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;animation:dsh-hm-spin .8s linear infinite}
@keyframes dsh-hm-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.dsh-hm-spinner{animation:none}}
.dsh-hm-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.dsh-hm-label{font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.dsh-hm-input,.dsh-hm-select,.dsh-hm-textarea{display:block;width:100%;min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px;padding:6px 8px}
.dsh-hm-input::placeholder,.dsh-hm-textarea::placeholder{color:var(--dsw-alias-label-tertiary)}
.dsh-hm-input:disabled,.dsh-hm-select:disabled,.dsh-hm-textarea:disabled{opacity:.6;cursor:not-allowed}
.dsh-hm-input:read-only{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}
.dsh-hm-textarea{min-height:84px;resize:vertical;white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-hm-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dsh-hm-detail{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dsh-hm-value{display:flex;flex-direction:column;gap:2px;font-size:13px;line-height:20px;overflow-wrap:anywhere}
.dsh-hm-file{display:block;max-width:100%;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsh-hm-error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.dsh-hm-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;min-width:0}
.dsh-hm-grid-2{grid-template-columns:repeat(2,minmax(0,1fr))}
.dsh-hm-row{display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap;min-width:0}
.dsh-hm-row>.dsh-hm-field{flex:1 1 160px}
.dsh-hm-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.dsh-hm-toolbar{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:end;min-width:0}
.dsh-hm-toolbar-query{min-width:0}
.dsh-hm-toolbar-filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;align-items:end;min-width:0}
.dsh-hm-check{display:flex;align-items:flex-start;gap:8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);cursor:pointer;min-width:0}
.dsh-hm-check input{flex:none;width:16px;height:16px;margin:2px 0 0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.dsh-hm-check-text{min-width:0;overflow-wrap:anywhere}
.dsh-hm-toggle-wrap{display:flex;flex-direction:column;gap:4px}
.dsh-hm-toggle-row{display:flex;align-items:center;gap:8px}
.dsh-hm-switch{appearance:none;position:relative;flex:none;width:32px;height:18px;margin:0;border-radius:999px;background:var(--dsw-alias-border-l2);cursor:pointer;transition:background .15s}
.dsh-hm-switch::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground);transition:transform .15s}
.dsh-hm-switch:checked{background:var(--dsw-alias-brand-primary)}
.dsh-hm-switch:checked::after{transform:translateX(14px)}
.dsh-hm-switch:disabled{opacity:.55;cursor:not-allowed}
.dsh-hm-toggle-label{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);cursor:pointer}
.dsh-hm-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:8px;min-width:0}
.dsh-hm-stat{display:flex;flex-direction:column;gap:2px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);padding:12px;min-width:0}
.dsh-hm-stat-value{font-size:18px;line-height:26px;font-weight:600;overflow-wrap:anywhere}
.dsh-hm-stat-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsh-hm-badge{display:inline-flex;align-items:center;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;padding:1px 6px;white-space:nowrap;max-width:100%;overflow-wrap:anywhere}
.dsh-hm-badge[data-tone="type"]{color:var(--dsw-alias-brand-primary);border-color:currentColor}
.dsh-hm-badge[data-tone="archived"]{color:var(--dsw-alias-state-warn-primary);border-color:currentColor}
.dsh-hm-badge[data-tone="success"]{color:var(--dsw-alias-state-success-primary);border-color:currentColor}
.dsh-hm-note{display:flex;align-items:flex-start;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);padding:8px 12px;font-size:12px;line-height:18px;min-width:0}
.dsh-hm-note-dot{flex:none;width:6px;height:6px;margin-top:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}
.dsh-hm-note[data-kind="success"] .dsh-hm-note-dot{background:var(--dsw-alias-state-success-primary)}
.dsh-hm-note[data-kind="error"] .dsh-hm-note-dot{background:var(--dsw-alias-state-error-primary)}
.dsh-hm-note[data-kind="warn"] .dsh-hm-note-dot{background:var(--dsw-alias-state-warn-primary)}
.dsh-hm-note[data-kind="error"]{border-color:var(--dsw-alias-state-error-primary)}
.dsh-hm-note[data-kind="warn"]{border-color:var(--dsw-alias-state-warn-primary)}
.dsh-hm-note-body{min-width:0;overflow-wrap:anywhere;display:flex;flex-direction:column;gap:2px}
.dsh-hm-memory-list{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none;min-width:0}
.dsh-hm-memory{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);padding:12px;min-width:0}
.dsh-hm-memory-text{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:20px}
.dsh-hm-memory-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);min-width:0}
.dsh-hm-memory-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-hm-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.dsh-hm-confirm{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);padding:12px;min-width:0}
.dsh-hm-confirm-text{margin:0;font-size:13px;line-height:20px;overflow-wrap:anywhere}
.dsh-hm-form{display:flex;flex-direction:column;gap:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);padding:12px;min-width:0}
.dsh-hm-form-title{margin:0;font-size:13px;line-height:20px;font-weight:600}
.dsh-hm-pagination{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:space-between;min-width:0}
.dsh-hm-page-meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsh-hm-path-list{display:flex;flex-direction:column;gap:8px;min-width:0}
.dsh-hm-path{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsh-hm-path-row{display:flex;align-items:center;gap:8px;min-width:0}
.dsh-hm-path-row>.dsh-hm-input{flex:1 1 auto}
.dsh-hm-path-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsh-hm-proposal-list{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none;min-width:0}
.dsh-hm-proposal{display:flex;flex-direction:column;gap:2px;width:100%;text-align:left;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:transparent;color:inherit;font:inherit;padding:8px 10px;cursor:pointer;min-width:0}
.dsh-hm-proposal:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-hm-proposal[aria-pressed="true"]{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1)}
.dsh-hm-proposal-id{font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dsh-hm-proposal-meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dsh-hm-group-list{display:flex;flex-direction:column;gap:12px;min-width:0}
.dsh-hm-group{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:12px;min-width:0}
.dsh-hm-group-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-hm-member-list{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none;min-width:0}
.dsh-hm-member{display:flex;flex-direction:column;gap:2px;border-left:2px solid var(--dsw-alias-border-l2);padding:0 0 0 8px;min-width:0}
.dsh-hm-member-text{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:18px}
.dsh-hm-skill-list{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none;min-width:0}
.dsh-hm-skill{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsh-hm-skill-name{font-size:13px;line-height:20px;font-weight:500}
.dsh-hm-skill-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dsh-hm-capabilities{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;min-width:0}
.dsh-hm-capability{display:flex;align-items:center;justify-content:space-between;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);padding:6px 8px;font-size:12px;line-height:18px;min-width:0}
.dsh-hm-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.dsh-hm-empty{display:flex;flex-direction:column;gap:4px;border:1px dashed var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);padding:16px;text-align:center;color:var(--dsw-alias-label-secondary);min-width:0}
.dsh-hm-empty-title{margin:0;font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsh-hm-empty-body{margin:0;font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dsh-hm-link{color:var(--dsw-alias-brand-primary);text-decoration:underline;text-underline-offset:2px;overflow-wrap:anywhere}
.dsh-hm-divider{border:none;border-top:1px solid var(--dsw-alias-border-l1);margin:0;width:100%}
@media (max-width:520px){.dsh-hm-grid-2{grid-template-columns:minmax(0,1fr)}.dsh-hm-toolbar{grid-template-columns:minmax(0,1fr)}}
`;

		// ── shared components ──────────────────────────────────────────────
		function Spinner() {
			return h("span", { className: "dsh-hm-spinner", "aria-hidden": "true" });
		}

		function Button({ children, onClick, disabled, busy, variant, type, ariaLabel, title }) {
			return h(
				"button",
				{
					type: type === undefined ? "button" : type,
					className: "dsh-hm-btn" + (variant ? " dsh-hm-btn-" + variant : ""),
					onClick,
					disabled: disabled === true || busy === true,
					"aria-label": ariaLabel,
					"aria-busy": busy === true ? "true" : undefined,
					title,
				},
				busy === true ? h(Spinner, null) : null,
				h("span", null, children)
			);
		}

		function Card({ id, title, description, actions, children, headingLevel }) {
			const titleId = id + "-title";
			const tag = "h" + (headingLevel === undefined ? 2 : headingLevel);
			return h(
				"section",
				{ className: "dsh-hm-card", id, "aria-labelledby": titleId },
				h(
					"div",
					{ className: "dsh-hm-card-head" },
					h(
						"div",
						{ className: "dsh-hm-card-heading" },
						h(tag, { className: "dsh-hm-card-title", id: titleId }, title),
						description ? h("p", { className: "dsh-hm-card-desc" }, description) : null
					),
					actions ? h("div", { className: "dsh-hm-card-actions" }, actions) : null
				),
				children ? h("div", { className: "dsh-hm-card-body" }, children) : null
			);
		}

		function Field({ id, label, hint, children, className }) {
			return h(
				"div",
				{ className: "dsh-hm-field" + (className ? " " + className : "") },
				h("label", { className: "dsh-hm-label", htmlFor: id }, label),
				children,
				hint ? h("div", { className: "dsh-hm-hint" }, hint) : null
			);
		}

		function TextInput({ className, ...props }) {
			return h("input", Object.assign({}, props, { className: "dsh-hm-input" + (className ? " " + className : "") }));
		}

		function NumberInput({ className, ...props }) {
			return h(
				"input",
				Object.assign({ type: "number", inputMode: "decimal", step: "any" }, props, {
					className: "dsh-hm-input" + (className ? " " + className : ""),
				})
			);
		}

		function TextArea({ className, ...props }) {
			return h("textarea", Object.assign({}, props, { className: "dsh-hm-textarea" + (className ? " " + className : "") }));
		}

		function Select({ className, children, ...props }) {
			return h(
				"select",
				Object.assign({}, props, { className: "dsh-hm-select" + (className ? " " + className : "") }),
				children
			);
		}

		function Checkbox({ id, checked, onChange, label, disabled }) {
			return h(
				"label",
				{ className: "dsh-hm-check", htmlFor: id },
				h("input", {
					id,
					type: "checkbox",
					checked: checked === true,
					disabled: disabled === true,
					onChange: (event) => onChange(event.target.checked),
				}),
				h("span", { className: "dsh-hm-check-text" }, label)
			);
		}

		function Toggle({ id, checked, onChange, label, hint, disabled }) {
			return h(
				"div",
				{ className: "dsh-hm-toggle-wrap" },
				h(
					"div",
					{ className: "dsh-hm-toggle-row" },
					h("input", {
						id,
						type: "checkbox",
						role: "switch",
						className: "dsh-hm-switch",
						checked: checked === true,
						disabled: disabled === true,
						"aria-checked": checked === true ? "true" : "false",
						onChange: (event) => onChange(event.target.checked),
					}),
					h("label", { className: "dsh-hm-toggle-label", htmlFor: id }, label)
				),
				hint ? h("div", { className: "dsh-hm-hint" }, hint) : null
			);
		}

		function Badge({ children, tone }) {
			return h("span", { className: "dsh-hm-badge", "data-tone": tone }, children);
		}

		function StatusLine({ t, kind, children }) {
			if (children === null || children === undefined || children === false) return null;
			const dataKind = kind === "success" ? "success" : kind === "error" ? "error" : kind === "warn" ? "warn" : "info";
			const role = dataKind === "error" ? "alert" : "status";
			return h(
				"div",
				{
					className: "dsh-hm-note",
					"data-kind": dataKind,
					role,
					"aria-live": dataKind === "error" ? undefined : "polite",
				},
				h("span", { className: "dsh-hm-note-dot", "aria-hidden": "true" }),
				h("div", { className: "dsh-hm-note-body" }, children)
			);
		}

		function ErrorNotice({ t, error, prefix }) {
			if (!error) return null;
			const detail = errorDetail(t, error);
			return h(
				StatusLine,
				{ t, kind: "error" },
				h("span", null, prefix ? prefix + " " + errorText(t, error) : errorText(t, error)),
				detail ? h("span", { className: "dsh-hm-detail" }, detail) : null
			);
		}

		function CopyButton({ t, value, label }) {
			const [state, setState] = useState("idle");
			const timer = useRef(null);
			useEffect(
				() => () => {
					if (timer.current !== null) clearTimeout(timer.current);
				},
				[]
			);
			const copy = useCallback(async () => {
				try {
					if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
						throw new Error("clipboard unavailable");
					}
					await navigator.clipboard.writeText(value === null || value === undefined ? "" : String(value));
					setState("copied");
				} catch (error) {
					setState("failed");
				}
				if (timer.current !== null) clearTimeout(timer.current);
				timer.current = setTimeout(() => setState("idle"), 1600);
			}, [value]);
			const text = state === "copied" ? t("actions.copied") : state === "failed" ? t("actions.copyFailed") : t("actions.copy");
			return h(
				React.Fragment,
				null,
				h(Button, { onClick: copy, ariaLabel: t("aria.copy", { label }), title }, text),
				h("span", { className: "dsh-hm-sr-only", role: "status" }, state === "copied" ? t("actions.copied") : "")
			);
		}

		function ConfirmBox({ t, message, confirmLabel, onConfirm, onCancel, busy, danger, children }) {
			return h(
				"div",
				{ className: "dsh-hm-confirm", role: "group", "aria-label": t("aria.confirm") },
				h("p", { className: "dsh-hm-confirm-text" }, message),
				children,
				h(
					"div",
					{ className: "dsh-hm-actions" },
					h(Button, { variant: danger ? "danger" : "primary", onClick: onConfirm, busy }, confirmLabel),
					h(Button, { variant: "ghost", onClick: onCancel, disabled: busy }, t("common.cancel"))
				)
			);
		}

		function EmptyState({ title, body }) {
			return h(
				"div",
				{ className: "dsh-hm-empty" },
				title ? h("p", { className: "dsh-hm-empty-title" }, title) : null,
				body ? h("p", { className: "dsh-hm-empty-body" }, body) : null
			);
		}

		function Tabs({ t, active, onChange }) {
			const refs = useRef({});
			const onKeyDown = (event) => {
				const index = TAB_KEYS.indexOf(active);
				let next = null;
				if (event.key === "ArrowRight") next = TAB_KEYS[(index + 1) % TAB_KEYS.length];
				else if (event.key === "ArrowLeft") next = TAB_KEYS[(index - 1 + TAB_KEYS.length) % TAB_KEYS.length];
				else if (event.key === "Home") next = TAB_KEYS[0];
				else if (event.key === "End") next = TAB_KEYS[TAB_KEYS.length - 1];
				if (next === null) return;
				event.preventDefault();
				onChange(next);
				const node = refs.current[next];
				if (node && typeof node.focus === "function") node.focus();
			};
			return h(
				"div",
				{ className: "dsh-hm-tabs", role: "tablist", "aria-label": t("aria.tabs"), onKeyDown },
				TAB_KEYS.map((key) =>
					h(
						"button",
						{
							key,
							ref: (node) => {
								refs.current[key] = node;
							},
							id: "dsh-hm-tab-" + key,
							type: "button",
							role: "tab",
							className: "dsh-hm-tab",
							"aria-selected": active === key ? "true" : "false",
							"aria-controls": "dsh-hm-panel-" + key,
							tabIndex: active === key ? 0 : -1,
							onClick: () => onChange(key),
						},
						t("tabs." + key)
					)
				)
			);
		}

		function backendStatus(config, status) {
			const kind = config && config.backend && config.backend.kind ? config.backend.kind : "none";
			const reported = status && status.backend ? status.backend : "unknown";
			if (kind === "none" || reported === "none") return "notConfigured";
			if (reported === "unknown") return "unknown";
			if (reported === "ready") return "ready";
			if (reported === "degraded") return "degraded";
			return "keywordOnly";
		}

		function kindLabel(t, kind) {
			const key = "settings.kind." + (kind || "none");
			return Object.prototype.hasOwnProperty.call(EN, key) ? t(key) : kind || t("common.unknown");
		}

		function typeLabel(t, type) {
			const key = "types." + type;
			return Object.prototype.hasOwnProperty.call(EN, key) ? t(key) : String(type || t("common.unknown"));
		}

		function countLabel(t, count) {
			return Number(count) === 1 ? t("memories.resultCountOne") : t("memories.resultCount", { count: formatCount(count) });
		}

		function InfoRow({ label, children }) {
			return h(
				"div",
				{ className: "dsh-hm-field" },
				h("div", { className: "dsh-hm-label" }, label),
				h("div", { className: "dsh-hm-value" }, children)
			);
		}

		function NoticeView({ t, notice }) {
			if (!notice) return null;
			return h(
				StatusLine,
				{ t, kind: notice.kind },
				h("span", null, notice.text),
				notice.detail ? h("span", { className: "dsh-hm-detail" }, notice.detail) : null
			);
		}

		function memoryOf(item) {
			return item && item.memory ? item.memory : item;
		}

		function itemsOf(value) {
			if (Array.isArray(value)) return value;
			if (value && Array.isArray(value.items)) return value.items;
			if (value && Array.isArray(value.results)) return value.results;
			if (value && Array.isArray(value.memories)) return value.memories;
			if (value && Array.isArray(value.proposals)) return value.proposals;
			return [];
		}

		function totalOf(value, fallback) {
			if (value && typeof value.total === "number" && Number.isFinite(value.total)) return value.total;
			return fallback;
		}

		function modeLabel(t, mode) {
			if (mode === "hybrid") return t("memories.mode.hybrid");
			if (mode === "keyword") return t("memories.mode.keyword");
			if (mode === "empty") return t("memories.mode.empty");
			return mode ? String(mode) : t("common.unknown");
		}

		// ── page shell ─────────────────────────────────────────────────────
		function MemorySettingsPage({ t }) {
			const [state, setState] = useState(null);
			const [loading, setLoading] = useState(true);
			const [refreshing, setRefreshing] = useState(false);
			const [loadError, setLoadError] = useState(null);
			const [active, setActive] = useState("overview");
			const [visited, setVisited] = useState(() => ({ overview: true }));
			const alive = useRef(true);

			useEffect(
				() => () => {
					alive.current = false;
				},
				[]
			);

			const reload = useCallback(async () => {
				setRefreshing(true);
				try {
					const next = await loadState();
					if (alive.current) {
						setState(next);
						setLoadError(null);
					}
					return next;
				} catch (error) {
					if (alive.current) setLoadError(error);
					return null;
				} finally {
					if (alive.current) {
						setLoading(false);
						setRefreshing(false);
					}
				}
			}, []);

			useEffect(() => {
				reload();
			}, [reload]);

			const selectTab = useCallback((key) => {
				if (TAB_KEYS.indexOf(key) < 0) return;
				setActive(key);
				setVisited((previous) => (previous[key] ? previous : Object.assign({}, previous, { [key]: true })));
			}, []);

			const statusKey = backendStatus(state && state.config, state && state.status);
			const statusText = t("status." + statusKey);
			const lastError = state && state.status ? state.status.lastError : null;
			const lastErrorText = lastError
				? typeof lastError === "string"
					? lastError
					: errorText(t, lastError)
				: "";
			const lastErrorDetail =
				lastError && typeof lastError === "object" ? errorDetail(t, lastError) : "";
			const lastErrorAt = lastError && typeof lastError === "object" && lastError.at ? formatDate(lastError.at) : "";

			const renderPanel = (key) => {
				if (!state) return null;
				if (key === "overview")
					return h(OverviewTab, { t, state, reload, onState: setState });
				if (key === "memories") return h(MemoriesTab, { t, state, reload });
				if (key === "curation")
					return h(CurationTab, { t, state, reload, onState: setState });
				return h(SettingsTab, { t, state, reload, onState: setState });
			};

			if (loading && !state) {
				return h(
					"div",
					{ className: "dsh-hm-root" },
					h("h1", { className: "dsh-hm-title" }, t("page.title")),
					h(
						"div",
						{ className: "dsh-hm-note", role: "status" },
						h(Spinner, null),
						h("div", { className: "dsh-hm-note-body" }, t("common.loading"))
					)
				);
			}

			if (!state) {
				return h(
					"div",
					{ className: "dsh-hm-root" },
					h("h1", { className: "dsh-hm-title" }, t("page.title")),
					h(
						"div",
						{ className: "dsh-hm-card" },
						h(ErrorNotice, { t, error: loadError, prefix: t("page.loadError") }),
						h(
							"div",
							{ className: "dsh-hm-actions" },
							h(Button, { variant: "primary", onClick: reload, busy: refreshing }, t("common.retry"))
						)
					)
				);
			}

			return h(
				"div",
				{ className: "dsh-hm-root" },
				h(
					"header",
					{ className: "dsh-hm-header" },
					h(
						"div",
						{ className: "dsh-hm-heading" },
						h("h1", { className: "dsh-hm-title" }, t("page.title")),
						h("p", { className: "dsh-hm-subtitle" }, t("page.subtitle"))
					),
					h(
						"div",
						{ className: "dsh-hm-header-actions" },
						h(
							"span",
							{
								className: "dsh-hm-pill",
								"data-state": statusKey,
								"aria-label": t("aria.status", { status: statusText }),
								title: t("aria.status", { status: statusText }),
							},
							h("span", { className: "dsh-hm-pill-dot", "aria-hidden": "true" }),
							statusText
						),
						h(
							Button,
							{ onClick: reload, busy: refreshing, ariaLabel: t("aria.refresh") },
							refreshing ? t("actions.refreshing") : t("actions.refresh")
						)
					)
				),
				lastError
					? h(
							"div",
							{ className: "dsh-hm-banner", role: "alert" },
							h("div", { className: "dsh-hm-banner-title" }, t("page.lastErrorTitle")),
							h("div", { className: "dsh-hm-banner-text" }, lastErrorText),
							lastErrorDetail ? h("div", { className: "dsh-hm-detail" }, lastErrorDetail) : null,
							lastErrorAt ? h("div", { className: "dsh-hm-detail" }, lastErrorAt) : null
						)
					: null,
				loadError ? h(ErrorNotice, { t, error: loadError }) : null,
				h(Tabs, { t, active, onChange: selectTab }),
				TAB_KEYS.map((key) =>
					h(
						"div",
						{
							key,
							id: "dsh-hm-panel-" + key,
							role: "tabpanel",
							"aria-labelledby": "dsh-hm-tab-" + key,
							tabIndex: 0,
							className: "dsh-hm-panel",
							hidden: active !== key,
						},
						visited[key] ? renderPanel(key) : null
					)
				)
			);
		}

		// ── overview ───────────────────────────────────────────────────────
		function testPartText(t, part) {
			if (!part) return t("status.notSet");
			if (part.ok === false) {
				return t("status.testFailed") + (part.error ? " — " + String(part.error) : "");
			}
			const details = [];
			if (part.model) details.push(String(part.model));
			if (typeof part.dimensions === "number") details.push(t("status.dimensions", { count: formatCount(part.dimensions) }));
			if (typeof part.latencyMs === "number") details.push(t("status.latency", { ms: Math.round(part.latencyMs) }));
			return details.length > 0 ? t("status.testOkWith", { details: details.join(" · ") }) : t("status.testOk");
		}

		function OverviewTab({ t, state, reload }) {
			const [busy, setBusy] = useState("");
			const [notice, setNotice] = useState(null);
			const [actionError, setActionError] = useState(null);
			const [testResult, setTestResult] = useState(null);

			const stats = state.stats || {};
			const config = state.config || {};
			const backend = config.backend || {};
			const kind = backend.kind || "none";
			const embedding = backend.embedding || {};
			const chat = backend.chat || {};
			const activeCount = Number(stats.active);
			const showEmpty = Number.isFinite(activeCount) && activeCount === 0;

			const runMaintenance = useCallback(
				async (action) => {
					setBusy(action);
					setActionError(null);
					setNotice(null);
					try {
						const value = await call("maintenance.run", { action });
						if (action === "maintain") {
							setNotice({
								kind: "success",
								text: t("result.maintenance", {
									archived: formatCount(value && value.archived),
									boosted: formatCount(value && value.boosted),
									decayed: formatCount(value && value.decayed),
									moved: formatCount(value && value.moved),
								}),
							});
						} else if (action === "backfill" || action === "backfillAll") {
							setNotice({
								kind: "success",
								text: t("result.backfill", {
									filled: formatCount(value && value.filled),
									skipped: formatCount(value && value.skipped),
									failed: formatCount(value && value.failed),
								}),
							});
						} else {
							const version =
								value && (value.version || value.short || value.semantic_version || value.shortVersion);
							setNotice({
								kind: "success",
								text: version ? t("result.stamp", { version: String(version) }) : t("result.stampPlain"),
							});
						}
						await reload();
					} catch (error) {
						setActionError(error);
					} finally {
						setBusy("");
					}
				},
				[reload, t]
			);

			const testConnection = useCallback(async () => {
				setBusy("test");
				setActionError(null);
				setTestResult(null);
				try {
					const value = await call("backend.test", { chat: true });
					setTestResult(value || {});
				} catch (error) {
					setActionError(error);
				} finally {
					setBusy("");
				}
			}, []);

			const statCards = [
				{ key: "active", label: t("overview.statActive"), value: formatCount(stats.active) },
				{ key: "archived", label: t("overview.statArchived"), value: formatCount(stats.archived) },
				{ key: "pending", label: t("overview.statPending"), value: formatCount(stats.pendingCompaction) },
				{ key: "total", label: t("overview.statTotal"), value: formatCount(stats.total) },
				{ key: "size", label: t("overview.statFileSize"), value: formatBytes(stats.fileSizeBytes) },
				{ key: "version", label: t("overview.statVersion"), value: stats.versionShort || "—" },
				{
					key: "maintenance",
					label: t("overview.statLastMaintenance"),
					value: state.status && state.status.lastMaintenance ? formatDate(state.status.lastMaintenance) : t("status.never"),
				},
			];

			return h(
				React.Fragment,
				null,
				h(
					Card,
					{ id: "dsh-hm-overview-stats", title: t("overview.statsTitle") },
					h(
						"div",
						{ className: "dsh-hm-stats" },
						statCards.map((item) =>
							h(
								"div",
								{ className: "dsh-hm-stat", key: item.key },
								h("div", { className: "dsh-hm-stat-value" }, item.value),
								h("div", { className: "dsh-hm-stat-label" }, item.label)
							)
						)
					)
				),
				showEmpty
					? h(
							Card,
							{ id: "dsh-hm-overview-empty", title: t("overview.emptyTitle") },
							h(EmptyState, { title: t("empty.memoriesTitle"), body: t("overview.emptyBody") })
						)
					: null,
				h(
					Card,
					{ id: "dsh-hm-overview-backend", title: t("overview.backendTitle"), description: t("overview.backendDesc") },
					h(
						"div",
						{ className: "dsh-hm-grid" },
						h(InfoRow, { label: t("overview.kind") }, kindLabel(t, kind)),
						h(
							InfoRow,
							{ label: t("overview.embedding") },
							h("div", null, embedding.model || t("overview.notSet")),
							h("div", { className: "dsh-hm-detail" }, embedding.url || "")
						),
						h(
							InfoRow,
							{ label: t("overview.chat") },
							h("div", null, chat.model || t("overview.notSet")),
							h("div", { className: "dsh-hm-detail" }, chat.url || "")
						),
						h(
							InfoRow,
							{ label: t("overview.lastTest") },
							testResult
								? h(
										"div",
										{ role: "status" },
										h("div", null, t("status.embedding") + ": " + testPartText(t, testResult.embedding)),
										h("div", null, t("status.chat") + ": " + testPartText(t, testResult.chat))
									)
								: t("status.neverTested")
						)
					),
					actionError ? h(ErrorNotice, { t, error: actionError }) : null,
					notice ? h(NoticeView, { t, notice }) : null
				),
				h(
					Card,
					{ id: "dsh-hm-overview-actions", title: t("overview.quickActions"), description: t("overview.quickActionsDesc") },
					h(
						"div",
						{ className: "dsh-hm-actions" },
						h(
							Button,
							{
								variant: "primary",
								onClick: testConnection,
								busy: busy === "test",
								disabled: kind === "none",
								ariaLabel: t("aria.testConnection"),
							},
							busy === "test" ? t("actions.testing") : t("actions.test")
						),
						h(
							Button,
							{ onClick: () => runMaintenance("maintain"), busy: busy === "maintain" },
							busy === "maintain" ? t("actions.running") : t("actions.runMaintenance")
						),
						h(
							Button,
							{ onClick: () => runMaintenance("backfill"), busy: busy === "backfill" },
							busy === "backfill" ? t("actions.running") : t("actions.backfillEmbeddings")
						),
						h(
							Button,
							{ onClick: () => runMaintenance("stamp"), busy: busy === "stamp" },
							busy === "stamp" ? t("actions.running") : t("actions.recomputeStamp")
						)
					)
				)
			);
		}

		// ── memories ───────────────────────────────────────────────────────
		function MemoriesTab({ t, state, reload }) {
			const pageSize = Math.max(1, Number(state.config && state.config.ui && state.config.ui.pageSize) || 20);
			const [mode, setMode] = useState("list");
			const [query, setQuery] = useState("");
			const [submittedQuery, setSubmittedQuery] = useState("");
			const [category, setCategory] = useState("");
			const [type, setType] = useState("");
			const [includeArchived, setIncludeArchived] = useState(false);
			const [page, setPage] = useState(1);
			const [refreshKey, setRefreshKey] = useState(0);
			const [items, setItems] = useState([]);
			const [total, setTotal] = useState(0);
			const [searchMeta, setSearchMeta] = useState(null);
			const [loading, setLoading] = useState(true);
			const [loadError, setLoadError] = useState(null);
			const [actionError, setActionError] = useState(null);
			const [notice, setNotice] = useState(null);
			const [form, setForm] = useState(null);
			const [formError, setFormError] = useState(null);
			const [formBusy, setFormBusy] = useState(false);
			const [deleteBusy, setDeleteBusy] = useState(false);
			const [deleteUnderstood, setDeleteUnderstood] = useState(false);
			const [archiveTarget, setArchiveTarget] = useState(null);
			const [archiveBusy, setArchiveBusy] = useState(false);

			const categories = Array.isArray(state.stats && state.stats.categories) ? state.stats.categories : [];
			const typeCounts = Array.isArray(state.stats && state.stats.types) ? state.stats.types : [];
			const typeOptions = MEMORY_TYPES.slice();
			typeCounts.forEach((entry) => {
				if (entry && entry.name && typeOptions.indexOf(entry.name) < 0) typeOptions.push(entry.name);
			});

			useEffect(() => {
				let cancelled = false;
				setLoading(true);
				setLoadError(null);
				const filters = {
					category: category || undefined,
					type: type || undefined,
					includeArchived,
				};
				const request =
					mode === "search"
						? call("memories.search", Object.assign({ query: submittedQuery, topK: 100 }, filters))
						: call(
								"memories.list",
								Object.assign({}, filters, { offset: (page - 1) * pageSize, limit: pageSize })
							);
				request
					.then((value) => {
						if (cancelled) return;
						if (mode === "search") {
							const list = itemsOf(value).map(memoryOf).filter(Boolean);
							setItems(list);
							setTotal(list.length);
							setSearchMeta(value || null);
						} else {
							const list = itemsOf(value).map(memoryOf).filter(Boolean);
							setItems(list);
							const nextTotal = totalOf(value, list.length);
							setTotal(nextTotal);
							setSearchMeta(null);
							const pages = Math.max(1, Math.ceil(nextTotal / pageSize));
							if (page > pages) setPage(pages);
						}
					})
					.catch((error) => {
						if (cancelled) return;
						setLoadError(error);
						setItems([]);
						setTotal(0);
					})
					.finally(() => {
						if (!cancelled) setLoading(false);
					});
				return () => {
					cancelled = true;
				};
			}, [mode, submittedQuery, page, category, type, includeArchived, pageSize, refreshKey]);

			const submitSearch = (event) => {
				if (event) event.preventDefault();
				const nextQuery = query.trim();
				if (nextQuery.length === 0) {
					clearSearch();
					return;
				}
				setPage(1);
				setSubmittedQuery(nextQuery);
				setMode("search");
				setRefreshKey((key) => key + 1);
			};

			const clearSearch = () => {
				setQuery("");
				setSubmittedQuery("");
				setMode("list");
				setPage(1);
				setRefreshKey((key) => key + 1);
				setSearchMeta(null);
			};

			const openAdd = () => {
				setForm({
					mode: "add",
					id: null,
					text: "",
					type: "general",
					category: "",
					eventDate: "",
					projectKey: "",
					dedupe: true,
				});
				setFormError(null);
				setDeleteUnderstood(false);
			};

			const openEdit = (memory) => {
				setForm({
					mode: "edit",
					id: memory.id,
					text: memory.text || "",
					type: memory.type || "general",
					category: memory.category || "",
					eventDate: memory.event_date ? String(memory.event_date).slice(0, 10) : "",
					projectKey: memory.project_key || "",
					dedupe: false,
				});
				setFormError(null);
				setDeleteUnderstood(false);
			};

			const closeForm = () => {
				setForm(null);
				setFormError(null);
				setDeleteUnderstood(false);
			};

			const updateForm = (patch) => {
				setForm((previous) => (previous ? Object.assign({}, previous, patch) : previous));
			};

			const saveForm = async () => {
				if (!form) return;
				const text = form.text.trim();
				if (text.length === 0) {
					setFormError(t("memories.textRequired"));
					return;
				}
				setFormBusy(true);
				setFormError(null);
				setActionError(null);
				try {
					const payload = { text, type: form.type };
					if (form.category.trim().length > 0) payload.category = form.category.trim();
					if (form.eventDate) payload.eventDate = form.eventDate;
					if (form.mode === "add") {
						if (form.projectKey.trim().length > 0) payload.projectKey = form.projectKey.trim();
						payload.dedupe = form.dedupe === true;
						const value = await call("memories.add", payload);
						if (value && value.added === false) {
							setNotice({
								kind: "warn",
								text: t("memories.duplicateNotice", { id: shortId(value.duplicateId) }),
							});
						} else {
							setNotice({
								kind: "success",
								text: t("memories.addedNotice"),
								detail: value && value.hasEmbedding === false ? t("memories.noEmbeddingWarning") : null,
							});
						}
					} else {
						payload.id = form.id;
						const value = await call("memories.update", payload);
						setNotice({
							kind: "success",
							text: t("memories.updatedNotice"),
							detail: value && value.hasEmbedding === false ? t("memories.noEmbeddingWarning") : null,
						});
					}
					closeForm();
					setRefreshKey((key) => key + 1);
					await reload();
				} catch (error) {
					setFormError(error);
				} finally {
					setFormBusy(false);
				}
			};

			const deleteMemory = async () => {
				if (!form || form.mode !== "edit" || !deleteUnderstood) return;
				setDeleteBusy(true);
				setFormError(null);
				setActionError(null);
				try {
					await call("memories.delete", { id: form.id, confirm: true });
					setNotice({ kind: "success", text: t("memories.deletedNotice") });
					closeForm();
					setRefreshKey((key) => key + 1);
					await reload();
				} catch (error) {
					setFormError(error);
				} finally {
					setDeleteBusy(false);
				}
			};

			const confirmArchive = async (memory) => {
				setArchiveBusy(true);
				setActionError(null);
				try {
					await call("memories.archive", { id: memory.id });
					setNotice({ kind: "success", text: t("memories.archivedNotice") });
					setArchiveTarget(null);
					setRefreshKey((key) => key + 1);
					await reload();
				} catch (error) {
					setActionError(error);
				} finally {
					setArchiveBusy(false);
				}
			};

			const pages = Math.max(1, Math.ceil(total / pageSize));
			const searching = mode === "search";

			const formErrorNode =
				formError === null || formError === undefined
					? null
					: typeof formError === "string"
						? h(StatusLine, { t, kind: "error" }, formError)
						: h(ErrorNotice, { t, error: formError });

			const renderMemory = (memory) => {
				const memoryId = memory.id;
				const archived = memory.archived === true;
				return h(
					"li",
					{ className: "dsh-hm-memory", key: String(memoryId) },
					h("div", { className: "dsh-hm-memory-text" }, memory.text === undefined ? "" : String(memory.text)),
					h(
						"div",
						{ className: "dsh-hm-memory-meta" },
						h(Badge, { tone: "type" }, typeLabel(t, memory.type)),
						memory.category ? h(Badge, null, String(memory.category)) : null,
						h("span", null, t("memories.energy", { value: formatNumber(memory.energy, 2) })),
						h(
							"span",
							null,
							memory.last_hit
								? t("memories.lastHit", { date: formatDate(memory.last_hit) })
								: t("memories.neverHit")
						),
						archived ? h(Badge, { tone: "archived" }, t("memories.archivedBadge")) : null,
						h(
							"span",
							{ className: "dsh-hm-inline" },
							h("span", { className: "dsh-hm-mono" }, shortId(memoryId)),
							h(CopyButton, { t, value: memoryId, label: t("memories.idLabel") })
						)
					),
					archiveTarget === memoryId
						? h(ConfirmBox, {
								t,
								message: t("memories.archiveConfirm"),
								confirmLabel: t("memories.archiveButton"),
								onConfirm: () => confirmArchive(memory),
								onCancel: () => setArchiveTarget(null),
								busy: archiveBusy,
							})
						: null,
					h(
						"div",
						{ className: "dsh-hm-memory-actions" },
						h(Button, { onClick: () => openEdit(memory) }, t("actions.edit")),
						archived
							? null
							: h(Button, { onClick: () => setArchiveTarget(memoryId) }, t("actions.archive"))
					)
				);
			};

			const formNode = form
				? h(
						"div",
						{
							className: "dsh-hm-form",
							role: "group",
							"aria-label": form.mode === "add" ? t("aria.addForm") : t("aria.editForm"),
						},
						h(
							"h3",
							{ className: "dsh-hm-form-title" },
							form.mode === "add" ? t("memories.addTitle") : t("memories.editTitle")
						),
						form.mode === "edit"
							? h("p", { className: "dsh-hm-hint" }, t("memories.editFor", { id: shortId(form.id) }))
							: null,
						h(
							Field,
							{ id: "dsh-hm-form-text", label: t("fields.text") },
							h(TextArea, {
								id: "dsh-hm-form-text",
								value: form.text,
								placeholder: t("placeholders.text"),
								required: true,
								onChange: (event) => updateForm({ text: event.target.value }),
							})
						),
						h(
							"div",
							{ className: "dsh-hm-grid dsh-hm-grid-2" },
							h(
								Field,
								{ id: "dsh-hm-form-type", label: t("fields.type") },
								h(
									Select,
									{
										id: "dsh-hm-form-type",
										value: form.type,
										onChange: (event) => updateForm({ type: event.target.value }),
									},
									typeOptions.map((option) =>
										h("option", { key: option, value: option }, typeLabel(t, option))
									)
								)
							),
							h(
								Field,
								{
									id: "dsh-hm-form-category",
									label: t("fields.category"),
								},
								h(TextInput, {
									id: "dsh-hm-form-category",
									value: form.category,
									list: "dsh-hm-category-options",
									placeholder: t("placeholders.category"),
									onChange: (event) => updateForm({ category: event.target.value }),
								}),
								h(
									"datalist",
									{ id: "dsh-hm-category-options" },
									categories.map((entry) =>
										h("option", { key: String(entry.name), value: String(entry.name) })
									)
								)
							),
							h(
								Field,
								{ id: "dsh-hm-form-event", label: t("fields.eventDate") },
								h(TextInput, {
									id: "dsh-hm-form-event",
									type: "date",
									value: form.eventDate,
									onChange: (event) => updateForm({ eventDate: event.target.value }),
								})
							),
							h(
								Field,
								{
									id: "dsh-hm-form-project",
									label: t("fields.projectKey"),
									hint: form.mode === "edit" ? t("memories.projectKeyReadOnly") : undefined,
								},
								h(TextInput, {
									id: "dsh-hm-form-project",
									value: form.projectKey,
									disabled: form.mode === "edit",
									placeholder: t("placeholders.projectKey"),
									onChange: (event) => updateForm({ projectKey: event.target.value }),
								})
							)
						),
						form.mode === "add"
							? h(
									"div",
									null,
									h(Checkbox, {
										id: "dsh-hm-form-dedupe",
										checked: form.dedupe,
										onChange: (checked) => updateForm({ dedupe: checked }),
										label: t("fields.dedupe"),
									}),
									h("div", { className: "dsh-hm-hint" }, t("hints.dedupe"))
								)
							: h("p", { className: "dsh-hm-hint" }, t("hints.editArchived")),
						formErrorNode,
						h(
							"div",
							{ className: "dsh-hm-actions" },
							h(Button, { variant: "primary", onClick: saveForm, busy: formBusy }, t("actions.saveMemory")),
							h(Button, { variant: "ghost", onClick: closeForm, disabled: formBusy }, t("common.cancel"))
						),
						form.mode === "edit"
							? h(
									"div",
									{ className: "dsh-hm-confirm" },
									h("h4", { className: "dsh-hm-form-title" }, t("memories.deleteTitle")),
									h("p", { className: "dsh-hm-hint" }, t("memories.deleteOnlyUser")),
									h("p", { className: "dsh-hm-error" }, t("memories.deleteWarning")),
									h(Checkbox, {
										id: "dsh-hm-delete-understood",
										checked: deleteUnderstood,
										onChange: setDeleteUnderstood,
										label: t("memories.deleteUnderstand"),
									}),
									h(
										Button,
										{
											variant: "danger",
											onClick: deleteMemory,
											disabled: !deleteUnderstood,
											busy: deleteBusy,
										},
										t("memories.deleteButton")
									)
								)
							: null
					)
				: null;

			return h(
				React.Fragment,
				null,
				h(
					Card,
					{ id: "dsh-hm-memories-toolbar", title: t("memories.toolbarTitle"), description: t("memories.toolbarDesc") },
					h(
						"form",
						{ className: "dsh-hm-toolbar", role: "search", onSubmit: submitSearch },
						h(
							Field,
							{ id: "dsh-hm-query", label: t("fields.query"), className: "dsh-hm-toolbar-query" },
							h(TextInput, {
								id: "dsh-hm-query",
								type: "search",
								value: query,
								autoComplete: "off",
								placeholder: t("placeholders.query"),
								onChange: (event) => setQuery(event.target.value),
							})
						),
						h(
							"div",
							{ className: "dsh-hm-actions" },
							h(Button, { type: "submit", variant: "primary" }, t("actions.search")),
							searching ? h(Button, { onClick: clearSearch }, t("actions.clearSearch")) : null
						)
					),
					h(
						"div",
						{ className: "dsh-hm-toolbar-filters" },
						h(
							Field,
							{ id: "dsh-hm-filter-category", label: t("fields.category") },
							h(
								Select,
								{
									id: "dsh-hm-filter-category",
									value: category,
									onChange: (event) => {
										setCategory(event.target.value);
										setPage(1);
									},
								},
								h("option", { value: "" }, t("common.all")),
								categories.map((entry) =>
									h("option", { key: String(entry.name), value: String(entry.name) }, String(entry.name))
								)
							)
						),
						h(
							Field,
							{ id: "dsh-hm-filter-type", label: t("fields.type") },
							h(
								Select,
								{
									id: "dsh-hm-filter-type",
									value: type,
									onChange: (event) => {
										setType(event.target.value);
										setPage(1);
									},
								},
								h("option", { value: "" }, t("common.all")),
								typeOptions.map((option) => h("option", { key: option, value: option }, typeLabel(t, option)))
							)
						),
						h(
							"div",
							{ className: "dsh-hm-field" },
							h(Checkbox, {
								id: "dsh-hm-filter-archived",
								checked: includeArchived,
								onChange: (checked) => {
									setIncludeArchived(checked);
									setPage(1);
								},
								label: t("fields.includeArchived"),
							})
						),
						h(
							Button,
							{
								variant: form && form.mode === "add" ? undefined : "primary",
								onClick: form && form.mode === "add" ? closeForm : openAdd,
							},
							form && form.mode === "add" ? t("common.cancel") : t("actions.addMemory")
						)
					),
					formNode
				),
				h(
					Card,
					{
						id: "dsh-hm-memories-results",
						title: t("tabs.memories"),
						description: searching
							? t("memories.searchNote", { count: formatCount(total), topK: 100 })
							: t("memories.newestFirst"),
						actions: h(Badge, null, countLabel(t, total)),
					},
					notice ? h(NoticeView, { t, notice }) : null,
					actionError ? h(ErrorNotice, { t, error: actionError }) : null,
					searchMeta && searchMeta.retrievalMode
						? h(
								"div",
								{ className: "dsh-hm-hint" },
								t("memories.searchMode", { mode: modeLabel(t, searchMeta.retrievalMode) })
							)
						: null,
					searching ? h("div", { className: "dsh-hm-hint" }, t("memories.searchTopKNote", { topK: 100 })) : null,
					searchMeta && Array.isArray(searchMeta.warnings) && searchMeta.warnings.length > 0
						? h(
								StatusLine,
								{ t, kind: "warn" },
								h("span", null, t("memories.warnings") + ": " + searchMeta.warnings.map(String).join("; "))
							)
						: null,
					loadError ? h(ErrorNotice, { t, error: loadError, prefix: t("memories.loadError") }) : null,
					loading
						? h(
								"div",
								{ className: "dsh-hm-note", role: "status" },
								h(Spinner, null),
								h("div", { className: "dsh-hm-note-body" }, t("common.loading"))
							)
						: loadError
							? h(
									"div",
									{ className: "dsh-hm-actions" },
									h(Button, { onClick: () => setRefreshKey((key) => key + 1) }, t("common.retry"))
								)
							: items.length === 0
								? h(EmptyState, {
										title: searching
											? t("memories.emptySearch")
											: category || type || includeArchived
												? t("memories.emptyFiltered")
												: t("empty.memoriesTitle"),
										body: searching
											? undefined
											: category || type || includeArchived
												? undefined
												: t("empty.memoriesBody"),
									})
								: h(
										"ul",
										{ className: "dsh-hm-memory-list", "aria-label": t("aria.searchResults") },
										items.map(renderMemory)
									),
					!searching && !loading && !loadError
						? h(
								"div",
								{ className: "dsh-hm-pagination", role: "group", "aria-label": t("aria.pagination") },
								h(
									"span",
									{ className: "dsh-hm-page-meta" },
									t("memories.pageOf", { page, pages }) +
										" · " +
										t("memories.totalCount", { count: formatCount(total) })
								),
								h(
									"div",
									{ className: "dsh-hm-actions" },
									h(
										Button,
										{ onClick: () => setPage((current) => Math.max(1, current - 1)), disabled: page <= 1 },
										t("actions.previous")
									),
									h(
										Button,
										{
											onClick: () => setPage((current) => Math.min(pages, current + 1)),
											disabled: page >= pages,
										},
										t("actions.next")
									)
								)
							)
						: null
				)
			);
		}

		function InlineError({ t, error }) {
			if (!error) return null;
			return typeof error === "string"
				? h(StatusLine, { t, kind: "error" }, error)
				: h(ErrorNotice, { t, error });
		}

		function draftText(value) {
			return value === null || value === undefined ? "" : String(value);
		}

		function draftNumber(raw) {
			const text = String(raw === null || raw === undefined ? "" : raw).trim();
			if (text.length === 0) return null;
			const number = Number(text);
			return Number.isFinite(number) ? number : null;
		}

		function maintenanceDraft(maintenance) {
			const source = maintenance || {};
			return {
				energyDecay: draftText(source.energyDecay),
				archiveDays: draftText(source.archiveDays),
				energyMax: draftText(source.energyMax),
				energyHitBoost: draftText(source.energyHitBoost),
			};
		}

		function consolidationDraft(consolidation) {
			const source = consolidation || {};
			const thresholds = source.typeThresholds || {};
			return {
				triggerCount: draftText(source.triggerCount),
				triggerSizeMb: draftText(source.triggerSizeMb),
				triggerDays: draftText(source.triggerDays),
				preference: draftText(thresholds.preference),
				event: draftText(thresholds.event),
				emotional: draftText(thresholds.emotional),
				general: draftText(thresholds.general),
				llmJudge: source.llmJudge === true,
			};
		}

		function proposalStatusLabel(t, status) {
			const key = "curation.status." + status;
			return Object.prototype.hasOwnProperty.call(EN, key) ? t(key) : String(status || t("common.unknown"));
		}

		function firstCount(source, keys) {
			if (!source) return null;
			for (let index = 0; index < keys.length; index += 1) {
				const value = source[keys[index]];
				if (typeof value === "number" && Number.isFinite(value)) return value;
			}
			return null;
		}

		function proposalCounts(summary) {
			const source = summary && summary.counts ? summary.counts : summary;
			return {
				merge: firstCount(source, ["merge_groups_count", "merge_groups", "mergeGroups", "merge"]),
				archive: firstCount(source, ["archive_candidates_count", "archive_candidates", "archiveCandidates", "archive"]),
				skill: firstCount(source, ["skill_candidates_count", "skill_candidates", "skillCandidates", "skill"]),
			};
		}

		function countsText(t, counts) {
			return t("curation.countsLine", {
				merge: counts.merge === null ? t("curation.unknownCount") : formatCount(counts.merge),
				archive: counts.archive === null ? t("curation.unknownCount") : formatCount(counts.archive),
				skill: counts.skill === null ? t("curation.unknownCount") : formatCount(counts.skill),
			});
		}

		function CurationTab({ t, state, reload, onState }) {
			const config = state.config || {};
			const maintenance = config.maintenance || {};
			const consolidation = config.consolidation || {};
			const stats = state.stats || {};
			const backend = config.backend || {};
			const kind = backend.kind || "none";
			const chat = backend.chat || {};
			const chatConfigured = kind !== "none" && Boolean(chat.url) && Boolean(chat.model);
			const pendingCompaction = Number(stats.pendingCompaction) || 0;

			const maintenanceSignature = JSON.stringify([
				maintenance.energyDecay,
				maintenance.archiveDays,
				maintenance.energyMax,
				maintenance.energyHitBoost,
			]);
			const [maintenanceForm, setMaintenanceForm] = useState(() => maintenanceDraft(maintenance));
			const maintenanceSignatureRef = useRef(maintenanceSignature);

			useEffect(() => {
				if (maintenanceSignatureRef.current === maintenanceSignature) return;
				maintenanceSignatureRef.current = maintenanceSignature;
				setMaintenanceForm(maintenanceDraft(maintenance));
			}, [maintenanceSignature, maintenance]);

			const consolidationSignature = JSON.stringify([
				consolidation.triggerCount,
				consolidation.triggerSizeMb,
				consolidation.triggerDays,
				consolidation.llmJudge,
				consolidation.typeThresholds,
			]);
			const [consolidationForm, setConsolidationForm] = useState(() => consolidationDraft(consolidation));
			const consolidationSignatureRef = useRef(consolidationSignature);

			useEffect(() => {
				if (consolidationSignatureRef.current === consolidationSignature) return;
				consolidationSignatureRef.current = consolidationSignature;
				setConsolidationForm(consolidationDraft(consolidation));
			}, [consolidationSignature, consolidation]);

			const [busy, setBusy] = useState("");
			const [actionError, setActionError] = useState(null);
			const [notice, setNotice] = useState(null);

			const [summaries, setSummaries] = useState(null);
			const [listBusy, setListBusy] = useState(false);
			const [listError, setListError] = useState(null);
			const [selectedId, setSelectedId] = useState(null);
			const [proposal, setProposal] = useState(null);
			const [detailBusy, setDetailBusy] = useState(false);
			const [detailError, setDetailError] = useState(null);
			const [detailRefresh, setDetailRefresh] = useState(0);
			const [selectedGroups, setSelectedGroups] = useState({});
			const [selectedArchives, setSelectedArchives] = useState({});
			const [editedTexts, setEditedTexts] = useState({});
			const [confirming, setConfirming] = useState(null);

			const updateMaintenanceForm = (patch) =>
				setMaintenanceForm((previous) => Object.assign({}, previous, patch));
			const updateConsolidationForm = (patch) =>
				setConsolidationForm((previous) => Object.assign({}, previous, patch));

			const saveMaintenance = async () => {
				const patch = {};
				const keys = ["energyDecay", "archiveDays", "energyMax", "energyHitBoost"];
				for (let index = 0; index < keys.length; index += 1) {
					const value = draftNumber(maintenanceForm[keys[index]]);
					if (value === null) {
						setActionError(t("fields.invalidNumber"));
						return;
					}
					patch[keys[index]] = value;
				}
				setBusy("save-maintenance");
				setActionError(null);
				setNotice(null);
				try {
					const next = await call("config.save", { maintenance: patch });
					if (next) onState(next);
					setNotice({ kind: "success", text: t("settings.maintenanceSaved") });
					await reload();
				} catch (error) {
					setActionError(error);
				} finally {
					setBusy("");
				}
			};

			const saveConsolidation = async () => {
				const numbers = {};
				const numberKeys = ["triggerCount", "triggerSizeMb", "triggerDays"];
				for (let index = 0; index < numberKeys.length; index += 1) {
					const value = draftNumber(consolidationForm[numberKeys[index]]);
					if (value === null) {
						setActionError(t("fields.invalidNumber"));
						return;
					}
					numbers[numberKeys[index]] = value;
				}
				const thresholds = {};
				const thresholdKeys = ["preference", "event", "emotional", "general"];
				for (let index = 0; index < thresholdKeys.length; index += 1) {
					const value = draftNumber(consolidationForm[thresholdKeys[index]]);
					if (value === null) {
						setActionError(t("fields.invalidNumber"));
						return;
					}
					thresholds[thresholdKeys[index]] = value;
				}
				setBusy("save-consolidation");
				setActionError(null);
				setNotice(null);
				try {
					const next = await call("config.save", {
						consolidation: Object.assign({}, numbers, {
							typeThresholds: thresholds,
							llmJudge: consolidationForm.llmJudge === true,
						}),
					});
					if (next) onState(next);
					setNotice({ kind: "success", text: t("settings.consolidationSaved") });
					await reload();
				} catch (error) {
					setActionError(error);
				} finally {
					setBusy("");
				}
			};

			const runMaintenanceAction = async (action) => {
				setBusy(action);
				setActionError(null);
				setNotice(null);
				try {
					const value = await call("maintenance.run", { action });
					if (action === "maintain") {
						setNotice({
							kind: "success",
							text: t("result.maintenance", {
								archived: formatCount(value && value.archived),
								boosted: formatCount(value && value.boosted),
								decayed: formatCount(value && value.decayed),
								moved: formatCount(value && value.moved),
							}),
						});
					} else if (action === "backfill" || action === "backfillAll") {
						setNotice({
							kind: "success",
							text: t("result.backfill", {
								filled: formatCount(value && value.filled),
								skipped: formatCount(value && value.skipped),
								failed: formatCount(value && value.failed),
							}),
						});
					} else {
						const version = value && (value.version || value.short || value.semantic_version || value.shortVersion);
						setNotice({
							kind: "success",
							text: version ? t("result.stamp", { version: String(version) }) : t("result.stampPlain"),
						});
					}
					await reload();
				} catch (error) {
					setActionError(error);
				} finally {
					setBusy("");
				}
			};

			const loadProposals = useCallback(async () => {
				setListBusy(true);
				setListError(null);
				try {
					const value = await call("consolidation.list", {});
					const list = Array.isArray(value) ? value : itemsOf(value);
					setSummaries(list);
					return list;
				} catch (error) {
					setListError(error);
					return null;
				} finally {
					setListBusy(false);
				}
			}, []);

			useEffect(() => {
				let cancelled = false;
				loadProposals().then((list) => {
					if (cancelled || !list || list.length === 0) return;
					setSelectedId((previous) => previous || list[0].proposal_id);
				});
				return () => {
					cancelled = true;
				};
			}, [loadProposals]);

			useEffect(() => {
				if (!selectedId) {
					setProposal(null);
					return;
				}
				let cancelled = false;
				setDetailBusy(true);
				setDetailError(null);
				call("consolidation.get", { id: selectedId })
					.then((value) => {
						if (cancelled) return;
						setProposal(value || null);
						const groups = {};
						const texts = {};
						(value && Array.isArray(value.merge_groups) ? value.merge_groups : []).forEach((group) => {
							groups[group.group_id] = true;
							texts[group.group_id] =
								group.proposed_text === null || group.proposed_text === undefined
									? ""
									: String(group.proposed_text);
						});
						const archives = {};
						(value && Array.isArray(value.archive_candidates) ? value.archive_candidates : []).forEach(
							(candidate) => {
								archives[candidate.id] = true;
							}
						);
						setSelectedGroups(groups);
						setEditedTexts(texts);
						setSelectedArchives(archives);
					})
					.catch((error) => {
						if (!cancelled) setDetailError(error);
					})
					.finally(() => {
						if (!cancelled) setDetailBusy(false);
					});
				return () => {
					cancelled = true;
				};
			}, [selectedId, detailRefresh]);

			const selectProposal = (id) => {
				setConfirming(null);
				setDetailError(null);
				if (id === selectedId) {
					setDetailRefresh((value) => value + 1);
				} else {
					setSelectedId(id);
				}
			};

			const generateProposal = async () => {
				setBusy("propose");
				setActionError(null);
				setNotice(null);
				try {
					const value = await call("consolidation.propose", {});
					const id = value && value.proposal_id ? value.proposal_id : null;
					if (id) {
						setNotice({ kind: "success", text: t("curation.generatedNotice", { id }) });
						setSelectedId(id);
						setConfirming(null);
					}
					await loadProposals();
					await reload();
				} catch (error) {
					setActionError(error);
				} finally {
					setBusy("");
				}
			};

			const executeProposal = async () => {
				if (!proposal) return;
				const groups = (Array.isArray(proposal.merge_groups) ? proposal.merge_groups : [])
					.filter((group) => selectedGroups[group.group_id] === true)
					.map((group) => group.group_id);
				const archiveIds = (Array.isArray(proposal.archive_candidates) ? proposal.archive_candidates : [])
					.filter((candidate) => selectedArchives[candidate.id] === true)
					.map((candidate) => candidate.id);
				if (groups.length === 0 && archiveIds.length === 0) {
					setDetailError(t("curation.nothingSelected"));
					setConfirming(null);
					return;
				}
				const mergedTexts = {};
				groups.forEach((groupId) => {
					mergedTexts[groupId] = editedTexts[groupId] === undefined ? "" : String(editedTexts[groupId]);
				});
				setBusy("execute");
				setDetailError(null);
				setNotice(null);
				try {
					const value = await call("consolidation.execute", {
						id: proposal.proposal_id,
						groups,
						archiveIds,
						mergedTexts,
					});
					setNotice({
						kind: "success",
						text: t("curation.executedResult", {
							merged: formatCount(value && value.merged_count),
							archived: formatCount(value && value.archived_count),
						}),
					});
					setConfirming(null);
					setDetailRefresh((current) => current + 1);
					await loadProposals();
					await reload();
				} catch (error) {
					setDetailError(error);
				} finally {
					setBusy("");
				}
			};

			const restoreProposal = async () => {
				if (!proposal) return;
				setBusy("restore");
				setDetailError(null);
				setNotice(null);
				try {
					await call("consolidation.restore", { id: proposal.proposal_id });
					setNotice({ kind: "success", text: t("curation.restoredResult") });
					setConfirming(null);
					setDetailRefresh((current) => current + 1);
					await loadProposals();
					await reload();
				} catch (error) {
					setDetailError(error);
				} finally {
					setBusy("");
				}
			};

			const refreshProposals = async () => {
				const list = await loadProposals();
				if (list && list.length > 0) {
					const stillThere = list.some((item) => item.proposal_id === selectedId);
					if (!stillThere) setSelectedId(list[0].proposal_id);
					else setDetailRefresh((current) => current + 1);
				}
			};

			const renderSummary = (summary) => {
				const id = summary.proposal_id;
				const counts = proposalCounts(summary);
				return h(
					"li",
					{ key: String(id) },
					h(
						"button",
						{
							type: "button",
							className: "dsh-hm-proposal",
							"aria-pressed": id === selectedId ? "true" : "false",
							onClick: () => selectProposal(id),
						},
						h(
							"span",
							{ className: "dsh-hm-proposal-id" },
							t("curation.proposalLine", {
								id,
								status: proposalStatusLabel(t, summary.status),
								date: summary.generated_at ? formatDate(summary.generated_at) : "—",
							})
						),
						h("span", { className: "dsh-hm-proposal-meta" }, countsText(t, counts))
					)
				);
			};

			const renderProposalDetail = () => {
				if (detailBusy && !proposal) {
					return h(
						"div",
						{ className: "dsh-hm-note", role: "status" },
						h(Spinner, null),
						h("div", { className: "dsh-hm-note-body" }, t("common.loading"))
					);
				}
				if (detailError) {
					return h(
						React.Fragment,
						null,
						h(InlineError, { t, error: detailError }),
						h(
							"div",
							{ className: "dsh-hm-actions" },
							h(Button, { onClick: () => setDetailRefresh((value) => value + 1) }, t("common.retry"))
						)
					);
				}
				if (!proposal) {
					return h(EmptyState, { body: t("curation.noProposalSelected") });
				}
				const current = proposal.current_stats || {};
				const byType = current.by_type && typeof current.by_type === "object" ? current.by_type : {};
				const groups = Array.isArray(proposal.merge_groups) ? proposal.merge_groups : [];
				const archives = Array.isArray(proposal.archive_candidates) ? proposal.archive_candidates : [];
				const skills = Array.isArray(proposal.skill_candidates) ? proposal.skill_candidates : [];
				const executed = proposal.status === "executed";
				const detailCounts = proposalCounts(proposal.summary);
				const selectedGroupCount = groups.filter((group) => selectedGroups[group.group_id] === true).length;
				const selectedArchiveCount = archives.filter(
					(candidate) => selectedArchives[candidate.id] === true
				).length;
				return h(
					"div",
					{ className: "dsh-hm-card-body" },
					h(
						"div",
						{ className: "dsh-hm-inline" },
						h("strong", null, t("curation.detailTitle", { id: proposal.proposal_id })),
						h(Badge, null, proposalStatusLabel(t, proposal.status)),
						proposal.generated_at
							? h("span", { className: "dsh-hm-page-meta" }, t("curation.generatedAt", { date: formatDate(proposal.generated_at) }))
							: null
					),
					h(
						"div",
						{ className: "dsh-hm-grid" },
						h(InfoRow, { label: t("curation.trigger") }, String(proposal.trigger_reason || "—")),
						h(InfoRow, { label: t("curation.currentStats") },
							h("div", null, t("curation.activeCount", { count: formatCount(current.active_count) })),
							h("div", null, t("curation.fileSizeMb", { size: formatNumber(current.file_size_mb, 1) })),
							h(
								"div",
								{ className: "dsh-hm-inline" },
								Object.keys(byType).length === 0
									? "—"
									: Object.keys(byType).map((key) =>
											h(Badge, { key, tone: "type" }, typeLabel(t, key) + " " + formatCount(byType[key]))
										)
							)
						),
						h(InfoRow, { label: t("curation.mergeGroups") }, countsText(t, detailCounts))
					),
					groups.length > 0
						? h(
								"div",
								null,
								h("h3", { className: "dsh-hm-form-title" }, t("curation.mergeGroups")),
								h(
									"div",
									{ className: "dsh-hm-group-list" },
									groups.map((group) =>
										h(
											"div",
											{ className: "dsh-hm-group", key: String(group.group_id) },
											h(
												"div",
												{ className: "dsh-hm-group-head" },
												h(Checkbox, {
													id: "dsh-hm-group-" + group.group_id,
													checked: selectedGroups[group.group_id] === true,
													onChange: (checked) =>
														setSelectedGroups((previous) =>
															Object.assign({}, previous, { [group.group_id]: checked })
														),
													label: t("curation.includeGroup", { id: group.group_id }),
												}),
												h(Badge, { tone: "type" }, typeLabel(t, group.type)),
												typeof group.similarity_max === "number"
													? h(
															"span",
															{ className: "dsh-hm-page-meta" },
															t("curation.similarity", { value: formatNumber(group.similarity_max, 3) })
														)
													: null
											),
											h(
												"ul",
												{ className: "dsh-hm-member-list" },
												(Array.isArray(group.memories) ? group.memories : []).map((member) =>
													h(
														"li",
														{ className: "dsh-hm-member", key: String(member.id) },
														h("div", { className: "dsh-hm-member-text" }, String(member.text || "")),
														h(
															"div",
															{ className: "dsh-hm-hint" },
															t("curation.memberMeta", {
																type: typeLabel(t, member.type),
																energy: formatNumber(member.energy, 2),
															})
														)
													)
												)
											),
											h(
												Field,
												{
													id: "dsh-hm-merged-" + group.group_id,
													label: t("curation.mergedText"),
												},
												h(TextArea, {
													id: "dsh-hm-merged-" + group.group_id,
													value:
														editedTexts[group.group_id] === undefined
															? String(group.proposed_text || "")
															: editedTexts[group.group_id],
													onChange: (event) =>
														setEditedTexts((previous) =>
															Object.assign({}, previous, { [group.group_id]: event.target.value })
														),
												})
											)
										)
									)
								)
							)
						: null,
					archives.length > 0
						? h(
								"div",
								null,
								h("h3", { className: "dsh-hm-form-title" }, t("curation.archiveCandidates")),
								h(
									"ul",
									{ className: "dsh-hm-member-list" },
									archives.map((candidate) =>
										h(
											"li",
											{ className: "dsh-hm-member", key: String(candidate.id) },
											h(Checkbox, {
												id: "dsh-hm-archive-" + candidate.id,
												checked: selectedArchives[candidate.id] === true,
												onChange: (checked) =>
													setSelectedArchives((previous) =>
														Object.assign({}, previous, { [candidate.id]: checked })
													),
												label: t("curation.includeArchive", { id: shortId(candidate.id) }),
											}),
											h("div", { className: "dsh-hm-member-text" }, String(candidate.text || "")),
											h(
												"div",
												{ className: "dsh-hm-hint" },
												t("curation.archiveReason", {
													reason: candidate.reason ? String(candidate.reason) : "—",
												})
											)
										)
									)
								)
							)
						: null,
					h(
						"div",
						null,
						h("h3", { className: "dsh-hm-form-title" }, t("curation.skillCandidates")),
						skills.length === 0
							? h("p", { className: "dsh-hm-hint" }, t("curation.noSkillCandidates"))
							: h(
									"ul",
									{ className: "dsh-hm-skill-list", "aria-label": t("aria.skillList") },
									skills.map((candidate) =>
										h(
											"li",
											{ className: "dsh-hm-skill", key: String(candidate.id) },
											h("div", { className: "dsh-hm-skill-name" }, String(candidate.id || "")),
											h("div", { className: "dsh-hm-skill-desc" }, String(candidate.text || "")),
											candidate.reason
												? h("div", { className: "dsh-hm-hint" }, t("curation.archiveReason", { reason: String(candidate.reason) }))
												: null
										)
									)
								)
					),
					h(
						"div",
						{ className: "dsh-hm-hint" },
						t("curation.countsLine", {
							merge: formatCount(selectedGroupCount),
							archive: formatCount(selectedArchiveCount),
							skill: formatCount(skills.length),
						})
					),
					confirming === "execute"
						? h(ConfirmBox, {
								t,
								message: t("curation.confirmExecute"),
								confirmLabel: t("actions.approveExecute"),
								onConfirm: executeProposal,
								onCancel: () => setConfirming(null),
								busy: busy === "execute",
							})
						: null,
					confirming === "restore"
						? h(ConfirmBox, {
								t,
								message: t("curation.confirmRestore"),
								confirmLabel: t("actions.restore"),
								onConfirm: restoreProposal,
								onCancel: () => setConfirming(null),
								busy: busy === "restore",
								danger: true,
							})
						: null,
					h(
						"div",
						{ className: "dsh-hm-actions" },
						h(
							Button,
							{
								variant: "primary",
								onClick: () => setConfirming("execute"),
								busy: busy === "execute",
								disabled: proposal.status === "executed" || proposal.status === "restored",
							},
							busy === "execute" ? t("actions.executing") : t("actions.approveExecute")
						),
						executed
							? h(
									Button,
									{
										onClick: () => setConfirming("restore"),
										busy: busy === "restore",
										danger: undefined,
									},
									busy === "restore" ? t("actions.restoring") : t("actions.restore")
								)
							: null,
						h(Button, { onClick: refreshProposals, disabled: listBusy }, t("actions.refreshProposals"))
					),
					!executed ? h("p", { className: "dsh-hm-hint" }, t("curation.snapshotHint")) : null
				);
			};

			return h(
				React.Fragment,
				null,
				h(
					Card,
					{ id: "dsh-hm-curation-maintenance", title: t("curation.maintenanceTitle"), description: t("curation.maintenanceDesc") },
					h(
						"div",
						{ className: "dsh-hm-grid dsh-hm-grid-2" },
						h(
							Field,
							{ id: "dsh-hm-maintenance-decay", label: t("fields.energyDecay") },
							h(NumberInput, {
								id: "dsh-hm-maintenance-decay",
								value: maintenanceForm.energyDecay,
								min: "0",
								onChange: (event) => updateMaintenanceForm({ energyDecay: event.target.value }),
							})
						),
						h(
							Field,
							{ id: "dsh-hm-maintenance-archive-days", label: t("fields.archiveDays") },
							h(NumberInput, {
								id: "dsh-hm-maintenance-archive-days",
								value: maintenanceForm.archiveDays,
								min: "0",
								onChange: (event) => updateMaintenanceForm({ archiveDays: event.target.value }),
							})
						),
						h(
							Field,
							{ id: "dsh-hm-maintenance-max", label: t("fields.energyMax") },
							h(NumberInput, {
								id: "dsh-hm-maintenance-max",
								value: maintenanceForm.energyMax,
								min: "0",
								onChange: (event) => updateMaintenanceForm({ energyMax: event.target.value }),
							})
						),
						h(
							Field,
							{ id: "dsh-hm-maintenance-boost", label: t("fields.hitBoost") },
							h(NumberInput, {
								id: "dsh-hm-maintenance-boost",
								value: maintenanceForm.energyHitBoost,
								min: "0",
								onChange: (event) => updateMaintenanceForm({ energyHitBoost: event.target.value }),
							})
						)
					),
					h(
						"div",
						{ className: "dsh-hm-actions" },
						h(
							Button,
							{ variant: "primary", onClick: saveMaintenance, busy: busy === "save-maintenance" },
							busy === "save-maintenance" ? t("actions.saving") : t("actions.saveMaintenance")
						),
						h(
							Button,
							{ onClick: () => runMaintenanceAction("maintain"), busy: busy === "maintain" },
							busy === "maintain" ? t("actions.running") : t("curation.runMaintenance")
						),
						h(
							Button,
							{ onClick: () => runMaintenanceAction("backfill"), busy: busy === "backfill" },
							busy === "backfill" ? t("actions.running") : t("curation.backfillMissing")
						),
						h(
							Button,
							{ onClick: () => runMaintenanceAction("backfillAll"), busy: busy === "backfillAll" },
							busy === "backfillAll" ? t("actions.running") : t("curation.backfillAll")
						),
						h(
							Button,
							{ onClick: () => runMaintenanceAction("stamp"), busy: busy === "stamp" },
							busy === "stamp" ? t("actions.running") : t("curation.recomputeStamp")
						)
					),
					h(
						"div",
						{ className: "dsh-hm-note" },
						h("span", { className: "dsh-hm-note-dot", "aria-hidden": "true" }),
						h(
							"div",
							{ className: "dsh-hm-note-body" },
							h("strong", null, t("curation.pendingCompaction", { count: formatCount(pendingCompaction) })),
							h("span", { className: "dsh-hm-hint" }, t("hints.compaction")),
							h(
								Button,
								{
									variant: "primary",
									onClick: () => runMaintenanceAction("maintain"),
									busy: busy === "maintain",
								},
								busy === "maintain" ? t("actions.running") : t("curation.compactNow")
							)
						)
					),
					h(InlineError, { t, error: actionError }),
					notice ? h(NoticeView, { t, notice }) : null
				),
				h(
					Card,
					{ id: "dsh-hm-curation-consolidation", title: t("curation.consolidationTitle"), description: t("curation.consolidationDesc") },
					h(
						"div",
						{ className: "dsh-hm-grid" },
						h(
							Field,
							{ id: "dsh-hm-consolidation-count", label: t("fields.triggerCount") },
							h(NumberInput, {
								id: "dsh-hm-consolidation-count",
								value: consolidationForm.triggerCount,
								min: "0",
								onChange: (event) => updateConsolidationForm({ triggerCount: event.target.value }),
							})
						),
						h(
							Field,
							{ id: "dsh-hm-consolidation-size", label: t("fields.triggerSizeMb") },
							h(NumberInput, {
								id: "dsh-hm-consolidation-size",
								value: consolidationForm.triggerSizeMb,
								min: "0",
								onChange: (event) => updateConsolidationForm({ triggerSizeMb: event.target.value }),
							})
						),
						h(
							Field,
							{ id: "dsh-hm-consolidation-days", label: t("fields.triggerDays") },
							h(NumberInput, {
								id: "dsh-hm-consolidation-days",
								value: consolidationForm.triggerDays,
								min: "0",
								onChange: (event) => updateConsolidationForm({ triggerDays: event.target.value }),
							})
						)
					),
					h(Toggle, {
						id: "dsh-hm-consolidation-judge",
						checked: consolidationForm.llmJudge,
						onChange: (checked) => updateConsolidationForm({ llmJudge: checked }),
						label: t("curation.llmJudge"),
						hint: t("hints.judge"),
					}),
					consolidationForm.llmJudge && !chatConfigured
						? h(StatusLine, { t, kind: "warn" }, t("curation.judgeUnavailable"))
						: null,
					h("h3", { className: "dsh-hm-form-title" }, t("curation.similarityTitle")),
					h(
						"div",
						{ className: "dsh-hm-grid dsh-hm-grid-2" },
						h(
							Field,
							{ id: "dsh-hm-threshold-preference", label: t("fields.similarityPreference") },
							h(NumberInput, {
								id: "dsh-hm-threshold-preference",
								value: consolidationForm.preference,
								min: "0",
								max: "1",
								onChange: (event) => updateConsolidationForm({ preference: event.target.value }),
							})
						),
						h(
							Field,
							{ id: "dsh-hm-threshold-event", label: t("fields.similarityEvent") },
							h(NumberInput, {
								id: "dsh-hm-threshold-event",
								value: consolidationForm.event,
								min: "0",
								max: "1",
								onChange: (event) => updateConsolidationForm({ event: event.target.value }),
							})
						),
						h(
							Field,
							{ id: "dsh-hm-threshold-emotional", label: t("fields.similarityEmotional") },
							h(NumberInput, {
								id: "dsh-hm-threshold-emotional",
								value: consolidationForm.emotional,
								min: "0",
								max: "1",
								onChange: (event) => updateConsolidationForm({ emotional: event.target.value }),
							})
						),
						h(
							Field,
							{ id: "dsh-hm-threshold-general", label: t("fields.similarityGeneral") },
							h(NumberInput, {
								id: "dsh-hm-threshold-general",
								value: consolidationForm.general,
								min: "0",
								max: "1",
								onChange: (event) => updateConsolidationForm({ general: event.target.value }),
							})
						)
					),
					h(
						"div",
						{ className: "dsh-hm-actions" },
						h(
							Button,
							{ variant: "primary", onClick: saveConsolidation, busy: busy === "save-consolidation" },
							busy === "save-consolidation" ? t("actions.saving") : t("actions.saveConsolidation")
						),
						h(
							Button,
							{ onClick: generateProposal, busy: busy === "propose" },
							busy === "propose" ? t("curation.generating") : t("curation.generate")
						)
					),
					h(InlineError, { t, error: actionError }),
					notice ? h(NoticeView, { t, notice }) : null
				),
				h(
					Card,
					{
						id: "dsh-hm-curation-proposals",
						title: t("curation.proposalsTitle"),
						description: summaries && summaries.length > 0 ? t("curation.proposalCount", { count: formatCount(summaries.length) }) : undefined,
						actions: h(Button, { onClick: refreshProposals, disabled: listBusy }, t("actions.refreshProposals")),
					},
					listError ? h(ErrorNotice, { t, error: listError, prefix: t("curation.listLoadError") }) : null,
					listBusy && summaries === null
						? h(
								"div",
								{ className: "dsh-hm-note", role: "status" },
								h(Spinner, null),
								h("div", { className: "dsh-hm-note-body" }, t("common.loading"))
							)
						: summaries === null || summaries.length === 0
							? h(EmptyState, { title: t("curation.noProposals") })
							: h("ul", { className: "dsh-hm-proposal-list" }, summaries.map(renderSummary)),
					renderProposalDetail()
				)
			);
		}

		// ── settings ───────────────────────────────────────────────────────
		function backendDraft(backend) {
			const source = backend || {};
			const embedding = source.embedding || {};
			const chat = source.chat || {};
			return {
				kind: source.kind || "none",
				embeddingUrl: draftText(embedding.url),
				embeddingModel: draftText(embedding.model),
				embeddingTimeout: draftText(embedding.timeoutMs),
				chatUrl: draftText(chat.url),
				chatModel: draftText(chat.model),
				chatTimeout: draftText(chat.timeoutMs),
				embeddingKey: "",
				chatKey: "",
				clearEmbeddingKey: false,
				clearChatKey: false,
			};
		}

		const BACKEND_PRESETS = {
			ollama: {
				embedding: { url: "http://127.0.0.1:11434/api/embeddings", model: "bge-m3" },
				chat: { url: "http://127.0.0.1:11434/api/generate", model: "qwen2.5:7b" },
			},
			"llama-cpp": {
				embedding: { url: "http://127.0.0.1:8080/v1/embeddings" },
				chat: { url: "http://127.0.0.1:8081/v1/chat/completions" },
			},
			"openai-compatible": {
				embedding: { url: "http://127.0.0.1:8080/v1/embeddings" },
				chat: { url: "http://127.0.0.1:8081/v1/chat/completions" },
			},
		};

		function PathRow({ t, id, label, value }) {
			return h(
				Field,
				{ id, label },
				h(
					"div",
					{ className: "dsh-hm-path-row" },
					h(TextInput, { id, value: value || "", readOnly: true, className: "dsh-hm-mono" }),
					h(CopyButton, { t, value: value || "", label })
				)
			);
		}

		function ConnectionCard({ t, state, onState }) {
			const backend = state.config && state.config.backend ? state.config.backend : {};
			const embedding = backend.embedding || {};
			const chat = backend.chat || {};
			const signature = JSON.stringify([
				backend.kind,
				embedding.url,
				embedding.model,
				embedding.timeoutMs,
				embedding.apiKeySet,
				chat.url,
				chat.model,
				chat.timeoutMs,
				chat.apiKeySet,
			]);
			const [form, setForm] = useState(() => backendDraft(backend));
			const signatureRef = useRef(signature);
			const [busy, setBusy] = useState("");
			const [notice, setNotice] = useState(null);
			const [actionError, setActionError] = useState(null);
			const [testResult, setTestResult] = useState(null);

			useEffect(() => {
				if (signatureRef.current === signature) return;
				signatureRef.current = signature;
				setForm(backendDraft(backend));
				setTestResult(null);
			}, [signature, backend]);

			const update = (patch) => setForm((previous) => Object.assign({}, previous, patch));
			const disabled = form.kind === "none";

			const applyPreset = () => {
				const preset = BACKEND_PRESETS[form.kind];
				if (!preset) return;
				setForm((previous) =>
					Object.assign({}, previous, {
						embeddingUrl: preset.embedding.url,
						embeddingModel:
							preset.embedding.model === undefined ? previous.embeddingModel : preset.embedding.model,
						chatUrl: preset.chat.url,
						chatModel: preset.chat.model === undefined ? previous.chatModel : preset.chat.model,
					})
				);
			};

			const save = async () => {
				const embeddingTimeout = draftNumber(form.embeddingTimeout);
				const chatTimeout = draftNumber(form.chatTimeout);
				if (embeddingTimeout === null || chatTimeout === null || embeddingTimeout <= 0 || chatTimeout <= 0) {
					setActionError(t("fields.invalidNumber"));
					return;
				}
				const patch = {
					backend: {
						kind: form.kind,
						embedding: {
							url: form.embeddingUrl.trim(),
							model: form.embeddingModel.trim(),
							timeoutMs: embeddingTimeout,
						},
						chat: {
							url: form.chatUrl.trim(),
							model: form.chatModel.trim(),
							timeoutMs: chatTimeout,
						},
					},
				};
				if (form.clearEmbeddingKey) patch.backend.embedding.apiKey = "";
				else if (form.embeddingKey.length > 0) patch.backend.embedding.apiKey = form.embeddingKey;
				if (form.clearChatKey) patch.backend.chat.apiKey = "";
				else if (form.chatKey.length > 0) patch.backend.chat.apiKey = form.chatKey;
				setBusy("save");
				setActionError(null);
				setNotice(null);
				try {
					const next = await call("config.save", patch);
					if (next) onState(next);
					setForm((previous) =>
						Object.assign({}, previous, {
							embeddingKey: "",
							chatKey: "",
							clearEmbeddingKey: false,
							clearChatKey: false,
						})
					);
					setNotice({ kind: "success", text: t("settings.connectionSaved") });
				} catch (error) {
					setActionError(error);
				} finally {
					setBusy("");
				}
			};

			const test = async () => {
				setBusy("test");
				setActionError(null);
				setTestResult(null);
				try {
					const value = await call("backend.test", { chat: true });
					setTestResult(value || {});
				} catch (error) {
					setActionError(error);
				} finally {
					setBusy("");
				}
			};

			return h(
				Card,
				{
					id: "dsh-hm-settings-connection",
					title: t("settings.connectionTitle"),
					description: t("settings.connectionDesc"),
				},
				h(
					"div",
					{ className: "dsh-hm-grid dsh-hm-grid-2" },
					h(
						Field,
						{ id: "dsh-hm-backend-kind", label: t("fields.backendKind") },
						h(
							Select,
							{
								id: "dsh-hm-backend-kind",
								value: form.kind,
								onChange: (event) => update({ kind: event.target.value }),
							},
							["ollama", "llama-cpp", "openai-compatible", "none"].map((kind) =>
								h("option", { key: kind, value: kind }, kindLabel(t, kind))
							)
						)
					),
					h(
						"div",
						{ className: "dsh-hm-field" },
						h(
							"div",
							{ className: "dsh-hm-actions" },
							h(
								Button,
								{ onClick: applyPreset, disabled: form.kind === "none" },
								t("actions.presetDefaults")
							)
						),
						h("div", { className: "dsh-hm-hint" }, t("hints.preset"))
					)
				),
				h("hr", { className: "dsh-hm-divider" }),
				h("h3", { className: "dsh-hm-form-title" }, t("settings.embeddingSection")),
				h(
					"div",
					{ className: "dsh-hm-grid dsh-hm-grid-2" },
					h(
						Field,
						{ id: "dsh-hm-embedding-url", label: t("fields.embeddingUrl") },
						h(TextInput, {
							id: "dsh-hm-embedding-url",
							value: form.embeddingUrl,
							disabled,
							placeholder: "http://127.0.0.1:11434/api/embeddings",
							onChange: (event) => update({ embeddingUrl: event.target.value }),
						})
					),
					h(
						Field,
						{ id: "dsh-hm-embedding-model", label: t("fields.embeddingModel") },
						h(TextInput, {
							id: "dsh-hm-embedding-model",
							value: form.embeddingModel,
							disabled,
							placeholder: "bge-m3",
							onChange: (event) => update({ embeddingModel: event.target.value }),
						})
					),
					h(
						Field,
						{
							id: "dsh-hm-embedding-key",
							label: t("fields.embeddingApiKey"),
							hint: t("hints.apiKey"),
						},
						h(TextInput, {
							id: "dsh-hm-embedding-key",
							type: "password",
							autoComplete: "off",
							value: form.embeddingKey,
							disabled,
							placeholder: embedding.apiKeySet
								? t("placeholders.apiKeyUnchanged")
								: t("placeholders.apiKeyEmpty"),
							onChange: (event) => update({ embeddingKey: event.target.value }),
						}),
						embedding.apiKeySet
							? h(Checkbox, {
									id: "dsh-hm-embedding-clear",
									checked: form.clearEmbeddingKey,
									onChange: (checked) => update({ clearEmbeddingKey: checked }),
									label: t("actions.clearKey"),
								})
							: null
					),
					h(
						Field,
						{ id: "dsh-hm-embedding-timeout", label: t("fields.embeddingTimeout") },
						h(NumberInput, {
							id: "dsh-hm-embedding-timeout",
							value: form.embeddingTimeout,
							min: "1",
							disabled,
							onChange: (event) => update({ embeddingTimeout: event.target.value }),
						})
					)
				),
				h("hr", { className: "dsh-hm-divider" }),
				h("h3", { className: "dsh-hm-form-title" }, t("settings.chatSection")),
				h(
					"div",
					{ className: "dsh-hm-grid dsh-hm-grid-2" },
					h(
						Field,
						{ id: "dsh-hm-chat-url", label: t("fields.chatUrl") },
						h(TextInput, {
							id: "dsh-hm-chat-url",
							value: form.chatUrl,
							disabled,
							placeholder: "http://127.0.0.1:11434/api/generate",
							onChange: (event) => update({ chatUrl: event.target.value }),
						})
					),
					h(
						Field,
						{ id: "dsh-hm-chat-model", label: t("fields.chatModel") },
						h(TextInput, {
							id: "dsh-hm-chat-model",
							value: form.chatModel,
							disabled,
							placeholder: "qwen2.5:7b",
							onChange: (event) => update({ chatModel: event.target.value }),
						})
					),
					h(
						Field,
						{ id: "dsh-hm-chat-key", label: t("fields.chatApiKey"), hint: t("hints.apiKey") },
						h(TextInput, {
							id: "dsh-hm-chat-key",
							type: "password",
							autoComplete: "off",
							value: form.chatKey,
							disabled,
							placeholder: chat.apiKeySet
								? t("placeholders.apiKeyUnchanged")
								: t("placeholders.apiKeyEmpty"),
							onChange: (event) => update({ chatKey: event.target.value }),
						}),
						chat.apiKeySet
							? h(Checkbox, {
									id: "dsh-hm-chat-clear",
									checked: form.clearChatKey,
									onChange: (checked) => update({ clearChatKey: checked }),
									label: t("actions.clearKey"),
								})
							: null
					),
					h(
						Field,
						{ id: "dsh-hm-chat-timeout", label: t("fields.chatTimeout") },
						h(NumberInput, {
							id: "dsh-hm-chat-timeout",
							value: form.chatTimeout,
							min: "1",
							disabled,
							onChange: (event) => update({ chatTimeout: event.target.value }),
						})
					)
				),
				testResult
					? h(
							"div",
							{ className: "dsh-hm-note", role: "status" },
							h("span", { className: "dsh-hm-note-dot", "aria-hidden": "true" }),
							h(
								"div",
								{ className: "dsh-hm-note-body" },
								h("strong", null, t("settings.testResult")),
								h("div", null, t("status.embedding") + ": " + testPartText(t, testResult.embedding)),
								h("div", null, t("status.chat") + ": " + testPartText(t, testResult.chat))
							)
						)
					: null,
				h(InlineError, { t, error: actionError }),
				notice ? h(NoticeView, { t, notice }) : null,
				h(
					"div",
					{ className: "dsh-hm-actions" },
					h(
						Button,
						{
							variant: "primary",
							onClick: save,
							busy: busy === "save",
							ariaLabel: t("aria.saveCard", { card: t("settings.connectionTitle") }),
						},
						busy === "save" ? t("actions.saving") : t("actions.saveConnection")
					),
					h(
						Button,
						{
							onClick: test,
							busy: busy === "test",
							disabled: form.kind === "none",
							ariaLabel: t("aria.testConnection"),
						},
						busy === "test" ? t("actions.testing") : t("actions.test")
					)
				)
			);
		}

		function SearchDefaultsCard({ t, state, onState }) {
			const search = state.config && state.config.search ? state.config.search : {};
			const signature = JSON.stringify([
				search.defaultTopK,
				search.maxTopK,
				search.minSimilarity,
				search.maxResultChars,
				search.rrfK,
			]);
			const [form, setForm] = useState(() => ({
				defaultTopK: draftText(search.defaultTopK),
				maxTopK: draftText(search.maxTopK),
				minSimilarity: draftText(search.minSimilarity),
				maxResultChars: draftText(search.maxResultChars),
				rrfK: draftText(search.rrfK),
			}));
			const signatureRef = useRef(signature);
			const [busy, setBusy] = useState(false);
			const [notice, setNotice] = useState(null);
			const [actionError, setActionError] = useState(null);

			useEffect(() => {
				if (signatureRef.current === signature) return;
				signatureRef.current = signature;
				setForm({
					defaultTopK: draftText(search.defaultTopK),
					maxTopK: draftText(search.maxTopK),
					minSimilarity: draftText(search.minSimilarity),
					maxResultChars: draftText(search.maxResultChars),
					rrfK: draftText(search.rrfK),
				});
			}, [signature, search]);

			const update = (patch) => setForm((previous) => Object.assign({}, previous, patch));

			const save = async () => {
				const keys = ["defaultTopK", "maxTopK", "minSimilarity", "maxResultChars", "rrfK"];
				const patch = {};
				for (let index = 0; index < keys.length; index += 1) {
					const value = draftNumber(form[keys[index]]);
					if (value === null) {
						setActionError(t("fields.invalidNumber"));
						return;
					}
					patch[keys[index]] = value;
				}
				setBusy(true);
				setActionError(null);
				setNotice(null);
				try {
					const next = await call("config.save", { search: patch });
					if (next) onState(next);
					setNotice({ kind: "success", text: t("settings.searchSaved") });
				} catch (error) {
					setActionError(error);
				} finally {
					setBusy(false);
				}
			};

			return h(
				Card,
				{
					id: "dsh-hm-settings-search",
					title: t("settings.searchTitle"),
					description: t("settings.searchDesc"),
				},
				h(
					"div",
					{ className: "dsh-hm-grid" },
					h(
						Field,
						{ id: "dsh-hm-search-topk", label: t("fields.defaultTopK") },
						h(NumberInput, {
							id: "dsh-hm-search-topk",
							value: form.defaultTopK,
							min: "1",
							onChange: (event) => update({ defaultTopK: event.target.value }),
						})
					),
					h(
						Field,
						{ id: "dsh-hm-search-max-topk", label: t("fields.maxTopK") },
						h(NumberInput, {
							id: "dsh-hm-search-max-topk",
							value: form.maxTopK,
							min: "1",
							onChange: (event) => update({ maxTopK: event.target.value }),
						})
					),
					h(
						Field,
						{ id: "dsh-hm-search-similarity", label: t("fields.minSimilarity") },
						h(NumberInput, {
							id: "dsh-hm-search-similarity",
							value: form.minSimilarity,
							min: "0",
							max: "1",
							onChange: (event) => update({ minSimilarity: event.target.value }),
						})
					),
					h(
						Field,
						{ id: "dsh-hm-search-chars", label: t("fields.maxResultChars") },
						h(NumberInput, {
							id: "dsh-hm-search-chars",
							value: form.maxResultChars,
							min: "1",
							onChange: (event) => update({ maxResultChars: event.target.value }),
						})
					),
					h(
						Field,
						{ id: "dsh-hm-search-rrf", label: t("fields.rrfK") },
						h(NumberInput, {
							id: "dsh-hm-search-rrf",
							value: form.rrfK,
							min: "1",
							onChange: (event) => update({ rrfK: event.target.value }),
						})
					)
				),
				h(InlineError, { t, error: actionError }),
				notice ? h(NoticeView, { t, notice }) : null,
				h(
					"div",
					{ className: "dsh-hm-actions" },
					h(
						Button,
						{
							variant: "primary",
							onClick: save,
							busy,
							ariaLabel: t("aria.saveCard", { card: t("settings.searchTitle") }),
						},
						busy ? t("actions.saving") : t("actions.saveSearch")
					)
				)
			);
		}

		function StorageCard({ t, state, reload, onState }) {
			const config = state.config || {};
			const paths = state.paths || {};
			const stats = state.stats || {};
			const signature = JSON.stringify([config.memoryDir]);
			const [memoryDir, setMemoryDir] = useState(() => draftText(config.memoryDir));
			const signatureRef = useRef(signature);
			const [busy, setBusy] = useState("");
			const [notice, setNotice] = useState(null);
			const [actionError, setActionError] = useState(null);

			const [importFile, setImportFile] = useState(null);
			const [importBackfill, setImportBackfill] = useState(true);
			const [confirmingImport, setConfirmingImport] = useState(false);
			const [importResult, setImportResult] = useState(null);
			const fileRef = useRef(null);

			useEffect(() => {
				if (signatureRef.current === signature) return;
				signatureRef.current = signature;
				setMemoryDir(draftText(config.memoryDir));
			}, [signature, config.memoryDir]);

			const save = async () => {
				const value = memoryDir.trim();
				if (value.length === 0) {
					setActionError(t("errors.INVALID_INPUT"));
					return;
				}
				setBusy("save");
				setActionError(null);
				setNotice(null);
				try {
					const next = await call("config.save", { memoryDir: value });
					if (next) onState(next);
					setNotice({ kind: "success", text: t("settings.storageSaved") });
				} catch (error) {
					setActionError(error);
				} finally {
					setBusy("");
				}
			};

			const exportData = async () => {
				setBusy("export");
				setActionError(null);
				setNotice(null);
				try {
					const value = await call("data.export", {});
					const parts = [];
					if (value && value.active) parts.push(String(value.active));
					if (value && value.archived) parts.push(String(value.archived));
					let text = parts.join("\n");
					if (text.length === 0) {
						setNotice({ kind: "warn", text: t("settings.exportEmpty") });
						return;
					}
					if (!text.endsWith("\n")) text += "\n";
					const blob = new Blob([text], { type: "application/x-ndjson;charset=utf-8" });
					const url = URL.createObjectURL(blob);
					const link = document.createElement("a");
					link.href = url;
					link.download = "her-memory-" + new Date().toISOString().replace(/[:.]/g, "-") + ".jsonl";
					link.rel = "noopener";
					link.click();
					setTimeout(() => URL.revokeObjectURL(url), 1000);
					setNotice({ kind: "success", text: t("settings.exportDone") });
				} catch (error) {
					setActionError(error);
				} finally {
					setBusy("");
				}
			};

			const readFile = async (event) => {
				const file = event.target.files && event.target.files[0] ? event.target.files[0] : null;
				setConfirmingImport(false);
				setImportResult(null);
				setActionError(null);
				if (!file) {
					setImportFile(null);
					return;
				}
				try {
					const text = await file.text();
					const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
					setImportFile({ name: file.name, text, lines });
				} catch (error) {
					setActionError(error);
				}
			};

			const runImport = async () => {
				if (!importFile) {
					setActionError(t("settings.importNoFile"));
					return;
				}
				setBusy("import");
				setActionError(null);
				setNotice(null);
				try {
					const value = await call("data.import", {
						jsonl: importFile.text,
						backfill: importBackfill === true,
					});
					setImportResult(value || {});
					setConfirmingImport(false);
					setImportFile(null);
					if (fileRef.current) fileRef.current.value = "";
					await reload();
				} catch (error) {
					setActionError(error);
				} finally {
					setBusy("");
				}
			};

			const pathRows = [
				{ key: "home", id: "dsh-hm-path-home", label: t("settings.homePath"), value: paths.home },
				{
					key: "active",
					id: "dsh-hm-path-active",
					label: t("settings.activeFile"),
					value: paths.activeFile,
				},
				{
					key: "archive",
					id: "dsh-hm-path-archive",
					label: t("settings.archiveFile"),
					value: paths.archiveFile,
				},
				{ key: "hit", id: "dsh-hm-path-hit", label: t("settings.hitFile"), value: paths.hitFile },
				{
					key: "version",
					id: "dsh-hm-path-version",
					label: t("settings.versionFile"),
					value: paths.versionFile,
				},
				{
					key: "snapshots",
					id: "dsh-hm-path-snapshots",
					label: t("settings.snapshotsDir"),
					value: paths.snapshotsDir,
				},
				{
					key: "proposals",
					id: "dsh-hm-path-proposals",
					label: t("settings.proposalsDir"),
					value: paths.proposalsDir,
				},
			];

			return h(
				Card,
				{ id: "dsh-hm-settings-storage", title: t("settings.storageTitle"), description: t("settings.storageDesc") },
				h(
					Field,
					{ id: "dsh-hm-memory-dir", label: t("fields.memoryDir"), hint: t("hints.memoryDir") },
					h(TextInput, {
						id: "dsh-hm-memory-dir",
						value: memoryDir,
						placeholder: t("placeholders.memoryDir"),
						onChange: (event) => setMemoryDir(event.target.value),
					})
				),
				h(InfoRow, { label: t("fields.fileSize") }, formatBytes(stats.fileSizeBytes)),
				h(
					"div",
					{ className: "dsh-hm-actions" },
					h(
						Button,
						{
							variant: "primary",
							onClick: save,
							busy: busy === "save",
							ariaLabel: t("aria.saveCard", { card: t("settings.storageTitle") }),
						},
						busy === "save" ? t("actions.saving") : t("actions.saveStorage")
					)
				),
				h("hr", { className: "dsh-hm-divider" }),
				h("h3", { className: "dsh-hm-form-title" }, t("settings.pathsTitle")),
				h(
					"div",
					{ className: "dsh-hm-path-list", role: "group", "aria-label": t("aria.pathList") },
					pathRows.map((row) => h(PathRow, { key: row.key, t, id: row.id, label: row.label, value: row.value }))
				),
				h("hr", { className: "dsh-hm-divider" }),
				h("h3", { className: "dsh-hm-form-title" }, t("settings.exportTitle")),
				h("p", { className: "dsh-hm-hint" }, t("settings.exportDesc")),
				h(
					"div",
					{ className: "dsh-hm-actions" },
					h(
						Button,
						{ onClick: exportData, busy: busy === "export" },
						busy === "export" ? t("actions.exporting") : t("actions.export")
					)
				),
				h("hr", { className: "dsh-hm-divider" }),
				h("h3", { className: "dsh-hm-form-title" }, t("settings.importTitle")),
				h("p", { className: "dsh-hm-hint" }, t("hints.import")),
				h(
					Field,
					{ id: "dsh-hm-import-file", label: t("fields.importFile") },
					h("input", {
						id: "dsh-hm-import-file",
						ref: fileRef,
						type: "file",
						accept: ".jsonl,application/x-ndjson,text/plain",
						className: "dsh-hm-file",
						onChange: readFile,
					})
				),
				importFile
					? h(
							"div",
							{ className: "dsh-hm-hint", role: "status" },
							t("settings.importPreview", { name: importFile.name, count: formatCount(importFile.lines) })
						)
					: null,
				h(Toggle, {
					id: "dsh-hm-import-backfill",
					checked: importBackfill,
					onChange: setImportBackfill,
					label: t("settings.importBackfill"),
				}),
				confirmingImport
					? h(ConfirmBox, {
							t,
							message: t("confirm.import", { count: formatCount(importFile ? importFile.lines : 0) }),
							confirmLabel: busy === "import" ? t("actions.importing") : t("actions.import"),
							onConfirm: runImport,
							onCancel: () => setConfirmingImport(false),
							busy: busy === "import",
						})
					: h(
							"div",
							{ className: "dsh-hm-actions" },
							h(
								Button,
								{
									onClick: () => {
										if (!importFile) {
											setActionError(t("settings.importNoFile"));
											return;
										}
										setActionError(null);
										setConfirmingImport(true);
									},
									disabled: !importFile,
								},
								t("actions.import")
							)
						),
				importResult
					? h(
							StatusLine,
							{ t, kind: "success" },
							t("settings.importResult", {
								imported: formatCount(importResult.imported),
								skipped: formatCount(importResult.skipped),
								invalid: formatCount(importResult.invalid),
								filled: formatCount(importResult.filled),
							})
						)
					: null,
				h(InlineError, { t, error: actionError }),
				notice ? h(NoticeView, { t, notice }) : null
			);
		}

		function AboutCard({ t, state }) {
			const plugin = state.plugin || {};
			const capabilities = state.capabilities || {};
			const skills = Array.isArray(state.skills) ? state.skills : [];
			const tools = Array.isArray(state.tools) ? state.tools : [];
			const capabilityRows = [
				{ key: "skills", label: t("settings.capabilitySkills"), enabled: capabilities.skills === true },
				{ key: "prompt", label: t("settings.capabilityPrompt"), enabled: capabilities.prompt === true },
				{ key: "webApi", label: t("settings.capabilityWebApi"), enabled: capabilities.webApi === true },
			];
			return h(
				Card,
				{ id: "dsh-hm-settings-about", title: t("settings.aboutTitle") },
				h(
					"div",
					{ className: "dsh-hm-grid" },
					h(InfoRow, { label: t("settings.aboutPlugin") }, plugin.name || "dsh-her-memory"),
					h(InfoRow, { label: t("settings.aboutVersion") }, plugin.version || "—"),
					h(
						InfoRow,
						{ label: t("settings.aboutLink") },
						h(
							"a",
							{
								className: "dsh-hm-link",
								href: "https://github.com/runs-agents/her.memory",
								target: "_blank",
								rel: "noreferrer noopener",
							},
							t("settings.aboutLink")
						)
					)
				),
				h("p", { className: "dsh-hm-hint" }, t("settings.aboutLicense")),
				h("hr", { className: "dsh-hm-divider" }),
				h("h3", { className: "dsh-hm-form-title" }, t("settings.aboutSkills")),
				skills.length === 0
					? h("p", { className: "dsh-hm-hint" }, t("settings.noSkills"))
					: h(
							"ul",
							{ className: "dsh-hm-skill-list", "aria-label": t("settings.aboutSkills") },
							skills.map((skill) =>
								h(
									"li",
									{ className: "dsh-hm-skill", key: String(skill.name) },
									h("div", { className: "dsh-hm-skill-name" }, String(skill.name || "")),
									skill.description ? h("div", { className: "dsh-hm-skill-desc" }, String(skill.description)) : null
								)
							)
						),
				h("h3", { className: "dsh-hm-form-title" }, t("settings.aboutTools")),
				tools.length === 0
					? h("p", { className: "dsh-hm-hint" }, t("settings.noTools"))
					: h(
							"div",
							{ className: "dsh-hm-inline" },
							tools.map((tool) => h(Badge, { key: String(tool), tone: "type" }, String(tool)))
						),
				h("h3", { className: "dsh-hm-form-title" }, t("settings.aboutCapabilities")),
				h(
					"div",
					{ className: "dsh-hm-capabilities" },
					capabilityRows.map((row) =>
						h(
							"div",
							{ className: "dsh-hm-capability", key: row.key },
							h("span", null, row.label),
							h(Badge, { tone: row.enabled ? "success" : undefined }, row.enabled ? t("settings.enabled") : t("settings.disabled"))
						)
					)
				),
				h("h3", { className: "dsh-hm-form-title" }, t("settings.aboutFormat")),
				h("p", { className: "dsh-hm-hint" }, t("settings.aboutFormatText"))
			);
		}

		function SettingsTab({ t, state, reload, onState }) {
			return h(
				React.Fragment,
				null,
				h(ConnectionCard, { t, state, onState }),
				h(SearchDefaultsCard, { t, state, onState }),
				h(StorageCard, { t, state, reload, onState }),
				h(AboutCard, { t, state })
			);
		}

		return {
			inject: ["slots", "locale"],
			apply(ctx) {
				ctx.effect(() => {
					if (typeof document === "undefined") return () => {};
					const style = document.createElement("style");
					style.dataset.plugin = "@local/dsh-her-memory";
					style.textContent = CSS;
					document.head.appendChild(style);
					return () => {
						if (style.parentNode) style.parentNode.removeChild(style);
					};
				}, "her-memory: styles");

				ctx.effect(() => ctx.locale.register("herMemory", { en: EN, zh: ZH }), "her-memory: locale");

				ctx.slots.inject("settings.section", () =>
					ctx.slots.register(
						{
							name: "settings.section",
							id: "her-memory",
							order: 30,
							label: () => ctx.locale.bind("herMemory")("nav.label"),
							locale: "herMemory",
						},
						MemorySettingsPage
					)
				);
			},
		};
	},
});
