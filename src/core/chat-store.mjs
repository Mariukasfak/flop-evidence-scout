import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const SAFE_CHAT_ID = /^[a-zA-Z0-9_-]+$/;
const DEFAULT_TITLE = 'Naujas pokalbis';
const MAX_TITLE_LENGTH = 64;

function deriveTitle(content) {
  const normalized = content
    .replace(/^\s*\/code\b\s*/iu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!normalized) return DEFAULT_TITLE;
  if (normalized.length <= MAX_TITLE_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}

function validateDataRoot(dataRoot) {
  const resolved = typeof dataRoot === 'object' && dataRoot !== null ? dataRoot.dataRoot : dataRoot;
  if (typeof resolved !== 'string' || !resolved.trim()) {
    throw new Error('Invalid dataRoot: must be a non-empty string');
  }
  return resolved.trim();
}

function validateChatId(chatId) {
  if (typeof chatId !== 'string' || !SAFE_CHAT_ID.test(chatId)) {
    throw new Error(`Invalid chatId: "${chatId}". Chat IDs must be non-empty and match /^[a-zA-Z0-9_-]+$/`);
  }
  return chatId;
}

function validateDate(value) {
  if (value === undefined || value === null) {
    return new Date().toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  throw new Error(`Invalid date format: ${value}`);
}

function validateContent(content) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('Message content must be a non-empty string');
  }
  return content;
}

function validateCouncil(council) {
  if (council === undefined || council === null) {
    return null;
  }
  if (typeof council !== 'object' || Array.isArray(council)) {
    throw new Error('Invalid council: must be a plain object');
  }
  try {
    JSON.stringify(council);
  } catch {
    throw new Error('Invalid council: must be JSON-serializable');
  }
  return council;
}

export class ChatStore {
  constructor(dataRoot) {
    this.dataRoot = validateDataRoot(dataRoot);
    this.chatsDir = path.join(this.dataRoot, 'chats');
    fs.mkdirSync(this.chatsDir, { recursive: true });
    this._queues = new Map();
  }

  _getChatFilePath(chatId) {
    validateChatId(chatId);
    return path.join(this.chatsDir, `${chatId}.jsonl`);
  }

  _enqueue(chatId, fn) {
    const prev = this._queues.get(chatId) || Promise.resolve();
    const op = prev.then(() => fn(), () => fn());
    this._queues.set(chatId, op.catch(() => {}));
    return op;
  }

  async _readChatEvents(chatId) {
    const filePath = this._getChatFilePath(chatId);
    let content;
    try {
      content = await fsp.readFile(filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error(`Chat not found: ${chatId}`);
      }
      throw err;
    }

    const lines = content.split('\n');
    let chat = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`Corrupt chat log in ${chatId} (line ${i + 1}): invalid JSON`);
      }

      if (!parsed || typeof parsed !== 'object') {
        throw new Error(`Corrupt chat log in ${chatId} (line ${i + 1}): event must be an object`);
      }

      const eventType = parsed.type || parsed.event;
      if (eventType === 'create_chat') {
        if (chat) {
          throw new Error(`Corrupt chat log in ${chatId} (line ${i + 1}): duplicate create_chat event`);
        }
        if (!parsed.chatId || !parsed.createdAt || !parsed.updatedAt) {
          throw new Error(`Corrupt chat log in ${chatId} (line ${i + 1}): missing create_chat fields`);
        }
        chat = {
          chatId: parsed.chatId,
          title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : DEFAULT_TITLE,
          createdAt: parsed.createdAt,
          updatedAt: parsed.updatedAt,
          messages: []
        };
      } else if (eventType === 'append_message') {
        if (!chat) {
          throw new Error(`Corrupt chat log in ${chatId} (line ${i + 1}): append_message before create_chat`);
        }
        const msg = parsed.message;
        if (!msg || typeof msg !== 'object') {
          throw new Error(`Corrupt chat log in ${chatId} (line ${i + 1}): invalid message object`);
        }
        if (!msg.id || !['user', 'assistant'].includes(msg.role) || typeof msg.content !== 'string' || !msg.createdAt) {
          throw new Error(`Corrupt chat log in ${chatId} (line ${i + 1}): invalid message fields`);
        }
        chat.messages.push(msg);
        if (typeof parsed.title === 'string' && parsed.title.trim()) {
          chat.title = parsed.title.trim();
        }
        chat.updatedAt = parsed.updatedAt || msg.createdAt;
      } else {
        throw new Error(`Corrupt chat log in ${chatId} (line ${i + 1}): unknown event type "${eventType}"`);
      }
    }

    if (!chat) {
      throw new Error(`Chat not found: ${chatId}`);
    }

    return chat;
  }

  async createChat({ chatId, title, createdAt } = {}) {
    const safeChatId = chatId ? validateChatId(chatId) : `chat-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const safeTitle = typeof title === 'string' && title.trim() ? title.trim() : DEFAULT_TITLE;
    const safeCreatedAt = validateDate(createdAt);
    const safeUpdatedAt = safeCreatedAt;

    const filePath = this._getChatFilePath(safeChatId);
    if (fs.existsSync(filePath)) {
      throw new Error(`Chat ${safeChatId} already exists`);
    }

    return this._enqueue(safeChatId, async () => {
      if (fs.existsSync(filePath)) {
        throw new Error(`Chat ${safeChatId} already exists`);
      }

      const event = {
        type: 'create_chat',
        chatId: safeChatId,
        title: safeTitle,
        createdAt: safeCreatedAt,
        updatedAt: safeUpdatedAt
      };

      await fsp.appendFile(filePath, `${JSON.stringify(event)}\n`, 'utf8');

      return {
        chatId: safeChatId,
        title: safeTitle,
        createdAt: safeCreatedAt,
        updatedAt: safeUpdatedAt,
        messages: []
      };
    });
  }

  async getChat(chatId) {
    validateChatId(chatId);
    return this._enqueue(chatId, async () => {
      return this._readChatEvents(chatId);
    });
  }

  async appendMessage(chatId, { role, content, runId, createdAt, council }) {
    validateChatId(chatId);
    validateContent(content);
    if (role !== 'user' && role !== 'assistant') {
      throw new Error(`Invalid message role: "${role}". Must be "user" or "assistant"`);
    }

    const safeCouncil = validateCouncil(council);
    const safeCreatedAt = validateDate(createdAt);
    const safeRunId = (typeof runId === 'string' && runId.trim()) ? runId.trim() : (runId ?? null);

    const messageId = `msg-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const message = {
      id: messageId,
      role,
      content,
      runId: safeRunId,
      createdAt: safeCreatedAt
    };

    if (role === 'assistant' && safeCouncil !== null) {
      message.council = safeCouncil;
    }

    return this._enqueue(chatId, async () => {
      // Ensure chat exists and is valid before appending
      const chat = await this._readChatEvents(chatId);

      const filePath = this._getChatFilePath(chatId);
      const event = {
        type: 'append_message',
        chatId,
        message,
        updatedAt: safeCreatedAt
      };
      if (role === 'user' && chat.title === DEFAULT_TITLE && chat.messages.length === 0) {
        event.title = deriveTitle(content);
      }

      await fsp.appendFile(filePath, `${JSON.stringify(event)}\n`, 'utf8');
      return message;
    });
  }

  async appendUserMessage(chatId, { content, runId, createdAt } = {}) {
    return this.appendMessage(chatId, {
      role: 'user',
      content,
      runId,
      createdAt
    });
  }

  async appendAssistantMessage(chatId, { content, runId, createdAt, council } = {}) {
    return this.appendMessage(chatId, {
      role: 'assistant',
      content,
      runId,
      createdAt,
      council
    });
  }

  async listChats() {
    let entries;
    try {
      entries = await fsp.readdir(this.chatsDir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }

    const chatFiles = entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl'));
    const chats = [];

    for (const file of chatFiles) {
      const chatId = file.name.slice(0, -6);
      if (!SAFE_CHAT_ID.test(chatId)) continue;
      const chat = await this.getChat(chatId);
      chats.push({
        chatId: chat.chatId,
        title: chat.title,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
        messageCount: chat.messages.length
      });
    }

    chats.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return chats;
  }
}
