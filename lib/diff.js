// Unified diff for remote writes/edits. Deliberately dependency-free: the
// bundle must install into a profile without pulling extra packages, and the
// remote host is never asked for `git diff` (the workspace may not be a repo).

const MAX_DIFF_LINES = 400
const CONTEXT = 3
// A line-level LCS table is O(n*m) Int32 cells. Cap the input so one large
// write cannot allocate hundreds of MB inside the Host process: 4000 lines of
// source already needs a 16M-cell guard, and the product check catches two
// moderately large files as well.
const MAX_LCS_CELLS = 4_000_000
const MAX_DIFF_SOURCE_LINES = 4000

function splitLines(text) {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Longest-common-subsequence table over lines, trimmed to the differing middle. */
function lcsMatrix(a, b) {
  const n = a.length
  const m = b.length
  const width = m + 1
  const table = new Int32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[i] === b[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
    }
  }
  return { table, width }
}

/** Edit script: [{type:' '|'-'|'+', text}] in source order. */
function editScript(a, b) {
  const { table, width } = lcsMatrix(a, b)
  const ops = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ type: ' ', text: a[i] })
      i += 1
      j += 1
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      ops.push({ type: '-', text: a[i] })
      i += 1
    } else {
      ops.push({ type: '+', text: b[j] })
      j += 1
    }
  }
  while (i < a.length) {
    ops.push({ type: '-', text: a[i] })
    i += 1
  }
  while (j < b.length) {
    ops.push({ type: '+', text: b[j] })
    j += 1
  }
  return ops
}

function hunkHeader(oldStart, oldCount, newStart, newCount) {
  const range = (start, count) => (count === 1 ? `${start}` : `${start},${count}`)
  return `@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@`
}

/**
 * Render a unified diff for one file. Returns '' when the texts are equal.
 * `label` is shown behind a/ and b/ (the remote absolute or workspace path).
 */
export function unifiedDiff(oldText, newText, label) {
  const a = splitLines(String(oldText ?? ''))
  const b = splitLines(String(newText ?? ''))
  if (a.length === b.length && a.every((line, index) => line === b[index])) return ''
  if (a.length > MAX_DIFF_SOURCE_LINES || b.length > MAX_DIFF_SOURCE_LINES || a.length * b.length > MAX_LCS_CELLS) {
    return {
      text: [
        `--- a/${label}`,
        `+++ b/${label}`,
        '@@ file replaced @@',
        `- ${a.length} lines`,
        `+ ${b.length} lines`,
        `[line diff skipped: ${a.length} -> ${b.length} lines is too large for an exact diff]`,
        '',
      ].join('\n'),
      added: 0,
      removed: 0,
      skipped: true,
    }
  }

  const ops = editScript(a, b)
  const changed = []
  ops.forEach((op, index) => {
    if (op.type !== ' ') changed.push(index)
  })
  const out = [`--- a/${label}`, `+++ b/${label}`]
  let added = 0
  let removed = 0
  for (const op of ops) {
    if (op.type === '+') added += 1
    if (op.type === '-') removed += 1
  }

  // Group changed op indexes into hunks separated by more than 2*CONTEXT
  // unchanged lines, keeping CONTEXT lines of context on each side.
  let cursor = 0
  let emitted = 0
  while (cursor < changed.length) {
    let end = cursor
    while (end + 1 < changed.length && changed[end + 1] - changed[end] <= CONTEXT * 2 + 1) end += 1
    const from = Math.max(0, changed[cursor] - CONTEXT)
    const to = Math.min(ops.length - 1, changed[end] + CONTEXT)
    const body = ops.slice(from, to + 1)
    let oldStart = 1
    let newStart = 1
    for (let index = 0; index < from; index += 1) {
      if (ops[index].type !== '+') oldStart += 1
      if (ops[index].type !== '-') newStart += 1
    }
    const oldCount = body.filter((op) => op.type !== '+').length
    const newCount = body.filter((op) => op.type !== '-').length
    out.push(hunkHeader(oldStart, oldCount, newStart, newCount))
    for (const op of body) out.push(op.type + op.text)
    emitted += body.length
    if (emitted > MAX_DIFF_LINES) {
      out.push(`... diff truncated after ${MAX_DIFF_LINES} lines ...`)
      break
    }
    cursor = end + 1
  }
  return { text: out.join('\n') + '\n', added, removed }
}
