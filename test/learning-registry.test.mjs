import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LearningRegistry, classifyTask } from '../src/core/learning-registry.mjs';

test('Learning Registry Tests', async (t) => {
    let testDir;
    let registry;

    t.beforeEach(async () => {
        testDir = await mkdtemp(join(tmpdir(), 'learning-registry-test-'));
        registry = new LearningRegistry({ root: testDir });
    });

    t.afterEach(async () => {
        if (testDir) {
            await rm(testDir, { recursive: true, force: true });
        }
    });

    await t.test('classifyTask', () => {
        assert.equal(classifyTask('write some code', true), 'code');
        assert.equal(classifyTask('research this', false), 'research');
        assert.equal(classifyTask('ištirk rinką ir šaltinius', false), 'research');
        assert.equal(classifyTask('write an essay', false), 'writing');
        assert.equal(classifyTask('parašyk lietuvišką tekstą', false), 'writing');
        assert.equal(classifyTask('plan the project', false), 'planning');
        assert.equal(classifyTask('sudaryk veiksmų planą', false), 'planning');
        assert.equal(classifyTask('suplanuokite svetainės kūrimą', false), 'planning');
        assert.equal(classifyTask('do something else', false), 'general');
    });

    await t.test('recordRun - valid', async () => {
        const agents = [
            { agentId: 'codex', proposalSucceeded: true, critiqueSucceeded: true, peerScore: 8, latencyMs: 120, owner: true, reviewer: false }
        ];
        const res = await registry.recordRun({ runId: 'run1', taskClass: 'code', completedAt: Date.now(), degraded: false, agents });
        assert.equal(res, true);
        
        // duplicate should return false
        const res2 = await registry.recordRun({ runId: 'run1', taskClass: 'code', completedAt: Date.now(), degraded: false, agents });
        assert.equal(res2, false);
    });
    
    await t.test('recordRun - validation', async () => {
        await assert.rejects(async () => {
            await registry.recordRun({ runId: '', taskClass: 'code', completedAt: Date.now(), degraded: false, agents: [] });
        }, /Invalid input/);
        
        await assert.rejects(async () => {
            const badAgents = [{ agentId: 'unknown', proposalSucceeded: true, critiqueSucceeded: true, peerScore: 8, latencyMs: 120, owner: true, reviewer: false }];
            await registry.recordRun({ runId: 'run2', taskClass: 'code', completedAt: Date.now(), degraded: false, agents: badAgents });
        }, /Invalid input/);

        const validAgent = { agentId: 'codex', proposalSucceeded: true, critiqueSucceeded: true, peerScore: 8, latencyMs: 120, owner: true, reviewer: false };
        await assert.rejects(
            registry.recordRun({ runId: '../escape', taskClass: 'code', completedAt: Date.now(), degraded: false, agents: [validAgent] }),
            /runId/
        );
        await assert.rejects(
            registry.recordRun({ runId: 'run-nan', taskClass: 'code', completedAt: Date.now(), degraded: false, agents: [{ ...validAgent, peerScore: NaN }] }),
            /peerScore/
        );
        await assert.rejects(
            registry.recordRun({ runId: 'run-degraded', taskClass: 'code', completedAt: Date.now(), degraded: 'false', agents: [validAgent] }),
            /degraded/
        );
        await assert.rejects(
            registry.recordRun({ runId: 'run-date', taskClass: 'code', completedAt: 'not-a-date', degraded: false, agents: [validAgent] }),
            /completedAt/
        );
        await assert.rejects(
            registry.recordRun({ runId: 'run-duplicate-agent', taskClass: 'code', completedAt: Date.now(), degraded: false, agents: [validAgent, validAgent] }),
            /duplicate agentId/
        );
    });

    await t.test('snapshot and priors', async () => {
        const agents = [
            { agentId: 'codex', proposalSucceeded: true, critiqueSucceeded: true, peerScore: 8, latencyMs: 120, owner: true, reviewer: false },
            { agentId: 'claude', proposalSucceeded: false, critiqueSucceeded: false, peerScore: null, latencyMs: 200, owner: false, reviewer: true }
        ];
        await registry.recordRun({ runId: 'run3', taskClass: 'code', completedAt: Date.now(), degraded: false, agents });
        
        const snap = await registry.snapshot('code');
        assert.equal(snap.taskClass, 'code');
        assert.equal(snap.totalRuns, 1);
        assert.ok(snap.agents.codex);
        assert.equal(snap.agents.codex.runs, 1);
        
        const pr = await registry.priors('code');
        assert.ok(pr.codex > 0.5 && pr.codex <= 0.75);
        assert.ok(pr.claude < 0.5);
    });

    await t.test('concurrent duplicate run writes exactly one append-only event', async () => {
        const evidence = {
            runId: 'run-concurrent',
            taskClass: 'general',
            completedAt: Date.now(),
            degraded: false,
            agents: [{ agentId: 'gemini', proposalSucceeded: true, critiqueSucceeded: true, peerScore: 9, latencyMs: 50, owner: true, reviewer: false }]
        };
        const results = await Promise.all([registry.recordRun(evidence), registry.recordRun(evidence)]);
        assert.deepEqual(results.sort(), [false, true]);
        const lines = (await readFile(join(testDir, 'learning.jsonl'), 'utf8')).trim().split('\n');
        assert.equal(lines.length, 1);
    });

    await t.test('corrupt persisted evidence fails loudly', async () => {
        await appendFile(join(testDir, 'learning.jsonl'), '{broken-json}\n', 'utf8');
        const fresh = new LearningRegistry({ root: testDir });
        await assert.rejects(fresh.snapshot(), /Corrupt JSONL line/);
    });
});
