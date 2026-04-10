#!/usr/bin/env npx tsx
/**
 * Matches WhatsApp LID participants to phone numbers using:
 * 1. Messages DB (LID → sender name)
 * 2. Contacts VCF file (name → phone)
 * 3. Group metadata (group → LID participants)
 *
 * Updates data/contacts/lid-phone-map.json with new matches.
 * Outputs JSON report for the scheduler script.
 */
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const DB_PATH = path.join(PROJECT_ROOT, 'store', 'messages.db');
const MAP_PATH = path.join(PROJECT_ROOT, 'data', 'contacts', 'lid-phone-map.json');
const VCF_PATH = path.join(PROJECT_ROOT, 'data', 'contacts', 'Contacts.vcf');

// --- Parse VCF contacts ---
function parseVCF(vcfPath: string): Array<{ name: string; phone: string }> {
  if (!fs.existsSync(vcfPath)) return [];
  const vcf = fs.readFileSync(vcfPath, 'utf-8');
  const cards = vcf.split('BEGIN:VCARD').filter(Boolean);

  function decodeQP(str: string): string {
    return str.replace(/=([0-9A-F]{2})/gi, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
  }

  function decodeLine(line: string): string {
    if (line.includes('QUOTED-PRINTABLE')) {
      // Handle multi-line QP (lines ending with =)
      const val = line.split(':').slice(1).join(':');
      return Buffer.from(decodeQP(val), 'binary').toString('utf-8');
    }
    return line.split(':').slice(1).join(':');
  }

  const contacts: Array<{ name: string; phone: string }> = [];
  for (const card of cards) {
    const lines = card.split(/\r?\n/);
    let name = '';
    let phone = '';
    for (let line of lines) {
      // Handle QP line continuations (trailing =)
      while (line.endsWith('=') && lines.indexOf(line) < lines.length - 1) {
        const nextIdx = lines.indexOf(line) + 1;
        line = line.slice(0, -1) + lines[nextIdx];
      }
      if (line.startsWith('FN')) {
        name = decodeLine(line).trim();
      }
      if (line.startsWith('TEL') && !phone) {
        const raw = line.split(':').slice(1).join(':').replace(/[^0-9+]/g, '');
        // Normalize to 972 format
        if (raw.startsWith('+972')) {
          phone = raw.replace('+', '');
        } else if (raw.startsWith('972')) {
          phone = raw;
        } else if (raw.startsWith('0') && raw.length >= 10) {
          phone = '972' + raw.slice(1);
        }
      }
    }
    if (name && phone) contacts.push({ name, phone });
  }
  return contacts;
}

// --- Normalize name for fuzzy matching ---
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z\u0590-\u05ff0-9\s]/g, '') // keep Hebrew, English, digits
    .replace(/\s+/g, ' ')
    .trim();
}

// --- Main ---
function main() {
  const db = new Database(DB_PATH, { readonly: true });

  // Load existing map
  let lidMap: Record<string, string> = {};
  if (fs.existsSync(MAP_PATH)) {
    lidMap = JSON.parse(fs.readFileSync(MAP_PATH, 'utf-8'));
  }

  // Get all registered WhatsApp groups
  const groups = db
    .prepare(
      "SELECT jid, name, folder FROM registered_groups WHERE jid LIKE '%@g.us'",
    )
    .all() as Array<{ jid: string; name: string; folder: string }>;

  // Get all known LID→name mappings from messages
  const senderRows = db
    .prepare(
      "SELECT DISTINCT sender, sender_name FROM messages WHERE sender LIKE '%@lid'",
    )
    .all() as Array<{ sender: string; sender_name: string }>;

  const lidToName: Record<string, string> = {};
  for (const row of senderRows) {
    const lidUser = row.sender.split('@')[0].split(':')[0];
    lidToName[lidUser] = row.sender_name;
  }

  // Parse contacts
  const contacts = parseVCF(VCF_PATH);

  // Try to match unmatched LIDs
  let newMatches = 0;
  for (const [lidUser, senderName] of Object.entries(lidToName)) {
    if (lidMap[lidUser]) continue; // already mapped

    const normalizedSender = normalizeName(senderName);
    // Try exact match first, then fuzzy
    const match = contacts.find((c) => {
      const normalizedContact = normalizeName(c.name);
      return (
        normalizedContact === normalizedSender ||
        normalizedContact.includes(normalizedSender) ||
        normalizedSender.includes(normalizedContact)
      );
    });

    if (match) {
      lidMap[lidUser] = match.phone;
      newMatches++;
    }
  }

  // Save updated map
  if (newMatches > 0) {
    fs.writeFileSync(MAP_PATH, JSON.stringify(lidMap, null, 2));
  }

  // Build report per group: which participants are still unmapped
  // We can't query group participants without connecting to WhatsApp,
  // so we check which senders from each group are unmapped
  const report: Array<{
    group: string;
    name: string;
    totalKnown: number;
    mapped: number;
    unmapped: Array<{ lid: string; name: string | null }>;
  }> = [];

  for (const group of groups) {
    const groupSenders = db
      .prepare(
        "SELECT DISTINCT sender, sender_name FROM messages WHERE chat_jid = ? AND sender LIKE '%@lid'",
      )
      .all(group.jid) as Array<{ sender: string; sender_name: string }>;

    const unmapped: Array<{ lid: string; name: string | null }> = [];
    let mapped = 0;
    for (const s of groupSenders) {
      const lidUser = s.sender.split('@')[0].split(':')[0];
      if (!lidMap[lidUser]) {
        unmapped.push({ lid: lidUser, name: s.sender_name });
      } else {
        mapped++;
      }
    }

    report.push({
      group: group.jid,
      name: group.name,
      totalKnown: groupSenders.length,
      mapped,
      unmapped,
    });
  }

  db.close();

  // Output result for scheduler
  const hasUnmapped = report.some((r) => r.unmapped.length > 0);
  const result = {
    wakeAgent: true, // always report daily
    data: {
      newMatches,
      totalMapped: Object.keys(lidMap).length,
      groups: report,
      allFullyMapped: !hasUnmapped && report.every((r) => r.totalKnown > 0),
    },
  };

  console.log(JSON.stringify(result));
}

main();
