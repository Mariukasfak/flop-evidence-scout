import fs from 'node:fs';
import path from 'node:path';
import { EVENT_TYPES, isValidEventType, isValidAgent } from './contracts.mjs';

function validateRunId(runId) {
  if (!runId || typeof runId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(runId)) {
    throw new Error('Invalid runId');
  }
}

export class RunStore {
  constructor(dataRoot) {
    this.dataRoot = dataRoot;
    fs.mkdirSync(this.dataRoot, { recursive: true });
    this.seqMap = new Map();
  }

  getRunFilePath(runId) {
    validateRunId(runId);
    return path.join(this.dataRoot, `${runId}.jsonl`);
  }

  createRun(runId, metadata = {}) {
    const filePath = this.getRunFilePath(runId);
    if (fs.existsSync(filePath)) {
      throw new Error(`Run ${runId} already exists`);
    }
    return this.appendEvent(runId, { type: EVENT_TYPES.RUN_CREATED, metadata });
  }

  // Paskutinis sekos numeris visada skaitomas is disko, o ne is kesavimo. Anksciau
  // kiekvienas RunStore egzempliorius turejo atskira skaitliuka, todel du egzemplioriai,
  // rasantys ta pati begima, isduodavo tuos pacius numerius. SSE srautas filtruoja pagal
  // (seq > lastSeq), tad pasikartojes ivykis tyliai dingdavo is narsykles.
  readLastSeq(filePath) {
    if (!fs.existsSync(filePath)) return 0;
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    if (!content) return 0;
    const lines = content.split('\n');
    const parsed = JSON.parse(lines[lines.length - 1]);
    // Sugadintas paskutinis irasas turi luzti garsiai. Anksciau neskaitinis seq tyliai
    // atstatydavo numeracija i 1 ir sukurdavo dublikatus prideliniame zurnale.
    if (!Number.isInteger(parsed.seq) || parsed.seq < 0) {
      throw new Error(`Corrupt run log: last record has an invalid seq (${parsed.seq})`);
    }
    return parsed.seq;
  }

  appendEvent(runId, event) {
    if (!isValidEventType(event.type)) {
      throw new Error(`Invalid event type: ${event.type}`);
    }
    // Tikrinama pagal undefined, o ne pagal teisinguma: '' ir 0 anksciau apeidavo patikra.
    if (event.agentId !== undefined && !isValidAgent(event.agentId)) {
      throw new Error(`Invalid agentId: ${event.agentId}`);
    }

    const filePath = this.getRunFilePath(runId);
    const seq = this.readLastSeq(filePath) + 1;
    this.seqMap.set(runId, seq);

    const eventRecord = {
      ...event,
      seq,
      timestamp: new Date().toISOString()
    };

    fs.appendFileSync(filePath, JSON.stringify(eventRecord) + '\n');
    return eventRecord;
  }

  async readEvents(runId) {
    const filePath = this.getRunFilePath(runId);
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const content = await fs.promises.readFile(filePath, 'utf-8');
    return content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  }
}
