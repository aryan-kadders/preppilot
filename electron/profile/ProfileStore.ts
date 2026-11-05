// Stores PrepPilot's profile documents (one active résumé, one active JD) in
// the app's existing SQLite database. main.ts hands over the shared
// better-sqlite3 handle (DatabaseManager.getDb()), the same file every other
// local feature uses, so the data lives in userData on both macOS and Windows.

import { randomUUID } from 'node:crypto';
import { DocType, type ExtractionMode, type ProfileDocument } from './types';

/** The subset of better-sqlite3's Database this store uses. */
export interface SqliteLike {
  exec(sql: string): unknown;
  prepare(sql: string): { run(...args: unknown[]): unknown; get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
}

export const PROFILE_TABLE = 'preppilot_profile_documents';

interface Row {
  id: string;
  doc_type: string;
  source_uri: string;
  file_name: string;
  raw_text: string;
  structured_json: string;
  extraction_mode: string;
  created_at: string;
  updated_at: string;
}

export interface SaveDocumentInput {
  docType: DocType;
  sourceUri: string;
  fileName: string;
  rawText: string;
  structured: Record<string, unknown>;
  extractionMode: ExtractionMode;
}

export class ProfileStore {
  constructor(private readonly db: SqliteLike, private readonly now: () => Date = () => new Date()) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${PROFILE_TABLE} (
      id TEXT PRIMARY KEY,
      doc_type TEXT NOT NULL UNIQUE,
      source_uri TEXT NOT NULL,
      file_name TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      structured_json TEXT NOT NULL,
      extraction_mode TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
  }

  /** Save (or replace) the active document of a type. Returns the stored document. */
  save(input: SaveDocumentInput): ProfileDocument {
    const at = this.now().toISOString();
    const doc: ProfileDocument = {
      id: randomUUID(),
      doc_type: input.docType,
      source_uri: input.sourceUri,
      file_name: input.fileName,
      raw_text: input.rawText,
      structured_data: input.structured,
      extraction_mode: input.extractionMode,
      // A replaced résumé is a new document: it gets a new id (so indexes keyed
      // on it rebuild) and a fresh created_at.
      created_at: at,
      updated_at: at,
    };
    this.db.prepare(`INSERT INTO ${PROFILE_TABLE}
        (id, doc_type, source_uri, file_name, raw_text, structured_json, extraction_mode, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(doc_type) DO UPDATE SET
          id = excluded.id, source_uri = excluded.source_uri, file_name = excluded.file_name,
          raw_text = excluded.raw_text, structured_json = excluded.structured_json,
          extraction_mode = excluded.extraction_mode, created_at = excluded.created_at,
          updated_at = excluded.updated_at`)
      .run(doc.id, doc.doc_type, doc.source_uri, doc.file_name, doc.raw_text, JSON.stringify(doc.structured_data), doc.extraction_mode, doc.created_at, doc.updated_at);
    return doc;
  }

  get(docType: DocType): ProfileDocument | null {
    const row = this.db.prepare(`SELECT * FROM ${PROFILE_TABLE} WHERE doc_type = ?`).get(docType) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  delete(docType: DocType): boolean {
    const res = this.db.prepare(`DELETE FROM ${PROFILE_TABLE} WHERE doc_type = ?`).run(docType) as { changes?: number };
    return (res?.changes ?? 0) > 0;
  }
}

function fromRow(row: Row): ProfileDocument {
  let structured: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.structured_json);
    if (parsed && typeof parsed === 'object') structured = parsed;
  } catch { /* a corrupt row keeps its raw text; facts read as empty */ }
  return {
    id: row.id,
    doc_type: row.doc_type === DocType.JD ? DocType.JD : DocType.RESUME,
    source_uri: row.source_uri,
    file_name: row.file_name,
    raw_text: row.raw_text,
    structured_data: structured,
    extraction_mode: row.extraction_mode === 'llm' ? 'llm' : 'heuristic',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
