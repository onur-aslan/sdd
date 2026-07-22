---
name: glossary-builder
disable-model-invocation: true
---

Auto-detect language and respond in the same language. One term at a time: ask which term, search the codebase for every plausible match, then show them as a numbered list plus an "I'll define it myself" option. If only one match exists, still confirm it rather than assuming; if zero matches exist, skip straight to the "define it myself" option. If the term already exists in the glossary, treat this as an update: re-search, show fresh candidates, replace the old entry in place — don't duplicate it. Once the user picks, save the file, ask "another term?", and repeat until done.

---

## Output Format

Save to `docs/sdd/domain-glossary.md` in the project root. One simple sentence per term: what it means → what it maps to.

```markdown
# Domain Glossary
_Generated: [date] | [N] terms | [N] mapped | [N] unmapped_

---

**Order** — A customer's request to purchase one or more products. Maps to `OrderAggregate`.

**Order Status** — The current stage of an order's lifecycle (pending, paid, shipped, etc). Maps to `OrderStatus` enum.

**Payment** — A transaction confirming funds received for an order. (No code match — defined by user.)

---
```