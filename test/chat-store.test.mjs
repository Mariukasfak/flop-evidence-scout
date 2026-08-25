import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { ChatStore } from '../src/core/chat-store.mjs';

test('ChatStore Tests', async (t) => {
    let testDir;
    let store;

    t.beforeEach(async () => {
        testDir = await mkdtemp(join(tmpdir(), 'chat-store-test-'));
        store = new ChatStore(testDir);
    });

    t.afterEach(async () => {
        if (testDir) {
            await rm(testDir, { recursive: true, force: true });
        }
    });

    await t.test('constructor creates chats subdirectory and validates dataRoot', async () => {
        assert.ok(existsSync(join(testDir, 'chats')), 'chats directory must be created under dataRoot');

        assert.throws(() => new ChatStore(''), /Invalid dataRoot/i);
        assert.throws(() => new ChatStore(null), /Invalid dataRoot/i);
        assert.throws(() => new ChatStore('   '), /Invalid dataRoot/i);
        assert.throws(() => new ChatStore(123), /Invalid dataRoot/i);

        // Also supports options object if provided
        const storeFromObj = new ChatStore({ dataRoot: testDir });
        assert.equal(storeFromObj.dataRoot, testDir);
    });

    await t.test('createChat creates chat with metadata and empty messages', async () => {
        const customDate = '2026-08-25T10:00:00.000Z';
        const chat = await store.createChat({
            chatId: 'chat-001',
            title: 'Mano pokalbis',
            createdAt: customDate
        });

        assert.equal(chat.chatId, 'chat-001');
        assert.equal(chat.title, 'Mano pokalbis');
        assert.equal(chat.createdAt, customDate);
        assert.equal(chat.updatedAt, customDate);
        assert.deepEqual(chat.messages, []);

        const filePath = join(testDir, 'chats', 'chat-001.jsonl');
        assert.ok(existsSync(filePath), 'JSONL file for chat must exist');
    });

    await t.test('createChat supports numeric timestamps and default invocation', async () => {
        const nowTs = Date.now();
        const chatWithNum = await store.createChat({
            chatId: 'chat-num',
            createdAt: nowTs
        });
        assert.equal(chatWithNum.createdAt, new Date(nowTs).toISOString());
        assert.equal(chatWithNum.title, 'Naujas pokalbis');

        const defaultChat = await store.createChat();
        assert.ok(defaultChat.chatId.startsWith('chat-'));
        assert.equal(defaultChat.title, 'Naujas pokalbis');
        assert.deepEqual(defaultChat.messages, []);
    });

    await t.test('createChat auto-generates stable id and fallback title when omitted', async () => {
        const chat1 = await store.createChat({});
        assert.ok(chat1.chatId && typeof chat1.chatId === 'string');
        assert.ok(chat1.title && typeof chat1.title === 'string' && chat1.title.length > 0);
        assert.ok(chat1.createdAt && chat1.updatedAt);
        assert.deepEqual(chat1.messages, []);

        const chat2 = await store.createChat({ title: '   ' });
        assert.ok(chat2.title && typeof chat2.title === 'string');
        assert.notEqual(chat1.chatId, chat2.chatId);
    });

    await t.test('createChat rejects duplicate chatId and invalid chatIds', async () => {
        await store.createChat({ chatId: 'unique-id', title: 'Pirmas' });

        await assert.rejects(
            () => store.createChat({ chatId: 'unique-id', title: 'Antras' }),
            /already exists/i
        );

        await assert.rejects(
            () => store.createChat({ chatId: '../escape-chat', title: 'Hack' }),
            /Invalid chatId/i
        );

        await assert.rejects(
            () => store.createChat({ chatId: 'chat with spaces', title: 'Hack' }),
            /Invalid chatId/i
        );

        await assert.rejects(
            () => store.createChat({ chatId: 'chat/slash', title: 'Hack' }),
            /Invalid chatId/i
        );

        await assert.rejects(
            () => store.createChat({ chatId: 'chat\\backslash', title: 'Hack' }),
            /Invalid chatId/i
        );
    });

    await t.test('getChat retrieves chat and throws clearly for unknown chat', async () => {
        await store.createChat({ chatId: 'chat-100', title: 'Testavimo pokalbis' });

        const retrieved = await store.getChat('chat-100');
        assert.equal(retrieved.chatId, 'chat-100');
        assert.equal(retrieved.title, 'Testavimo pokalbis');
        assert.deepEqual(retrieved.messages, []);

        await assert.rejects(
            () => store.getChat('non-existent-chat'),
            /not found|unknown chat/i
        );

        await assert.rejects(
            () => store.getChat('../invalid'),
            /Invalid chatId/i
        );
    });

    await t.test('appendUserMessage and appendAssistantMessage persist ordered messages and update updatedAt', async () => {
        const t0 = '2026-08-25T10:00:00.000Z';
        const t1 = '2026-08-25T10:01:00.000Z';
        const t2 = '2026-08-25T10:02:00.000Z';

        await store.createChat({ chatId: 'conv-1', title: 'Diskusija', createdAt: t0 });

        const userMsg = await store.appendUserMessage('conv-1', {
            content: 'Kaip veikia TriAgent taryba?',
            runId: 'run-001',
            createdAt: t1
        });

        assert.ok(userMsg.id && typeof userMsg.id === 'string');
        assert.equal(userMsg.role, 'user');
        assert.equal(userMsg.content, 'Kaip veikia TriAgent taryba?');
        assert.equal(userMsg.runId, 'run-001');
        assert.equal(userMsg.createdAt, t1);

        const councilAudit = {
            owner: 'codex',
            reviewer: 'claude',
            delegations: ['gemini'],
            scores: { codex: 9, claude: 8.5 }
        };

        const assistantMsg = await store.appendAssistantMessage('conv-1', {
            content: 'TriAgent taryba sujungia tris modelius su peer-review.',
            runId: 'run-001',
            createdAt: t2,
            council: councilAudit
        });

        assert.ok(assistantMsg.id && typeof assistantMsg.id === 'string');
        assert.notEqual(assistantMsg.id, userMsg.id);
        assert.equal(assistantMsg.role, 'assistant');
        assert.equal(assistantMsg.content, 'TriAgent taryba sujungia tris modelius su peer-review.');
        assert.equal(assistantMsg.runId, 'run-001');
        assert.equal(assistantMsg.createdAt, t2);
        assert.deepEqual(assistantMsg.council, councilAudit);

        const chat = await store.getChat('conv-1');
        assert.equal(chat.updatedAt, t2);
        assert.equal(chat.messages.length, 2);
        assert.deepEqual(chat.messages[0], userMsg);
        assert.deepEqual(chat.messages[1], assistantMsg);
    });

    await t.test('first user message replaces the fallback title with a bounded topic title', async () => {
        await store.createChat({ chatId: 'auto-title' });
        await store.appendUserMessage('auto-title', {
            content: '/code   Sukurk modernų transporto paslaugų puslapį su labai ilgu papildomu aprašymu, kuris neturi išplėsti kortelės',
            runId: 'run-title'
        });

        const chat = await store.getChat('auto-title');
        assert.match(chat.title, /^Sukurk modernų transporto paslaugų puslapį/);
        assert.ok(chat.title.length <= 64);
        assert.doesNotMatch(chat.title, /^\/code/);
    });

    await t.test('validation rejects invalid messages and traversal in appends', async () => {
        await store.createChat({ chatId: 'valid-chat' });

        // Empty content
        await assert.rejects(
            () => store.appendUserMessage('valid-chat', { content: '', runId: 'run-1' }),
            /content/i
        );
        await assert.rejects(
            () => store.appendUserMessage('valid-chat', { content: '   ', runId: 'run-1' }),
            /content/i
        );
        await assert.rejects(
            () => store.appendAssistantMessage('valid-chat', { content: null, runId: 'run-1' }),
            /content/i
        );
        await assert.rejects(
            () => store.appendAssistantMessage('valid-chat', { content: 12345, runId: 'run-1' }),
            /content/i
        );

        // Unknown chat
        await assert.rejects(
            () => store.appendUserMessage('unknown-chat', { content: 'Labas', runId: 'run-1' }),
            /not found|unknown chat/i
        );

        // Traversal chatId
        await assert.rejects(
            () => store.appendUserMessage('../hacked', { content: 'Labas', runId: 'run-1' }),
            /Invalid chatId/i
        );
        await assert.rejects(
            () => store.appendAssistantMessage('../hacked', { content: 'Labas', runId: 'run-1' }),
            /Invalid chatId/i
        );

        // Invalid council
        await assert.rejects(
            () => store.appendAssistantMessage('valid-chat', {
                content: 'Atsakymas',
                runId: 'run-1',
                council: 'not-an-object'
            }),
            /council/i
        );

        await assert.rejects(
            () => store.appendAssistantMessage('valid-chat', {
                content: 'Atsakymas',
                runId: 'run-1',
                council: [1, 2, 3]
            }),
            /council/i
        );
    });

    await t.test('persistence survives across new ChatStore instances', async () => {
        const chat = await store.createChat({ chatId: 'persist-1', title: 'Istorija' });
        await store.appendUserMessage('persist-1', { content: 'Pirmas klausimas', runId: 'r1' });
        await store.appendAssistantMessage('persist-1', { content: 'Pirmas atsakymas', runId: 'r1' });

        // Create fresh store instance on same directory
        const freshStore = new ChatStore(testDir);
        const restored = await freshStore.getChat('persist-1');

        assert.equal(restored.chatId, 'persist-1');
        assert.equal(restored.title, 'Istorija');
        assert.equal(restored.messages.length, 2);
        assert.equal(restored.messages[0].content, 'Pirmas klausimas');
        assert.equal(restored.messages[1].content, 'Pirmas atsakymas');
    });

    await t.test('listChats returns chat metadata sorted most recently updated first', async () => {
        // Empty store returns empty list
        assert.deepEqual(await store.listChats(), []);

        const t1 = '2026-08-25T10:00:00.000Z';
        const t2 = '2026-08-25T10:05:00.000Z';
        const t3 = '2026-08-25T10:10:00.000Z';

        await store.createChat({ chatId: 'chat-a', title: 'Chat A', createdAt: t1 });
        await store.createChat({ chatId: 'chat-b', title: 'Chat B', createdAt: t2 });

        let list = await store.listChats();
        assert.equal(list.length, 2);
        assert.equal(list[0].chatId, 'chat-b');
        assert.equal(list[1].chatId, 'chat-a');

        // Non-chat files in chats directory are safely ignored by listChats
        await writeFile(join(testDir, 'chats', 'ignore-me.txt'), 'random text');

        // Now update chat-a by appending a message at t3
        await store.appendUserMessage('chat-a', { content: 'Naujas pranešimas', runId: 'r2', createdAt: t3 });

        list = await store.listChats();
        assert.equal(list.length, 2);
        assert.equal(list[0].chatId, 'chat-a', 'chat-a should now be first because it was updated most recently');
        assert.equal(list[1].chatId, 'chat-b');
        assert.equal(list[0].updatedAt, t3);
        assert.equal(list[0].messageCount, 1);
        assert.equal(list[1].messageCount, 0);
    });

    await t.test('concurrent appends to the same chat serialize and lose no messages', async () => {
        await store.createChat({ chatId: 'conc-chat', title: 'Lygiagretus testas' });

        const count = 25;
        const appendPromises = [];
        for (let i = 0; i < count; i++) {
            appendPromises.push(
                store.appendUserMessage('conc-chat', {
                    content: `Žinutė ${i}`,
                    runId: `run-${i}`
                })
            );
        }

        const results = await Promise.all(appendPromises);
        assert.equal(results.length, count);

        const chat = await store.getChat('conc-chat');
        assert.equal(chat.messages.length, count);

        // Check all messages exist
        const contents = chat.messages.map(m => m.content);
        for (let i = 0; i < count; i++) {
            assert.ok(contents.includes(`Žinutė ${i}`), `Message ${i} must be preserved`);
        }

        // Verify JSONL file line count: 1 create_chat + 25 messages = 26 lines
        const fileContent = await readFile(join(testDir, 'chats', 'conc-chat.jsonl'), 'utf8');
        const lines = fileContent.trim().split('\n').filter(Boolean);
        assert.equal(lines.length, count + 1);
    });

    await t.test('corrupt JSONL lines fail loudly', async () => {
        await store.createChat({ chatId: 'corrupt-chat', title: 'Geras pradžioje' });
        const filePath = join(testDir, 'chats', 'corrupt-chat.jsonl');
        await appendFile(filePath, '{broken-json-line\n', 'utf8');

        const freshStore = new ChatStore(testDir);
        await assert.rejects(
            () => freshStore.getChat('corrupt-chat'),
            /Corrupt chat log|Invalid JSON/i
        );

        await assert.rejects(
            () => freshStore.listChats(),
            /Corrupt chat log|Invalid JSON/i
        );
    });
});
