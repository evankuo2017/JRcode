---
name: grill-me
description: Relentless Socratic interview that walks down every branch of a plan or design, resolving decisions one-by-one. Trigger ONLY when the user explicitly says "grill me" or the PT equivalent "me grille". Do NOT trigger for stress-test, poke holes, devil's advocate, challenge, review, or feedback requests.
license: MIT
---

# Grill Me

## Purpose

Stress-test a plan, design, or idea through relentless Socratic questioning. Walk down every branch of the decision tree, resolve dependencies between decisions one-by-one, and reach a shared understanding where no assumption is left unchallenged.

## When to Use

Trigger ONLY when the user explicitly uses the word "grill" — e.g.:
- "grill me on this"
- "grill me on my plan / architecture / design"
- "I want you to grill me before I present"
- PT: "me grille sobre esse plano"

Do NOT trigger for synonyms or near-misses, even when the intent seems similar:
- "stress-test this" → not grill-me
- "poke holes in my plan" → not grill-me
- "play devil's advocate" → not grill-me
- "challenge my assumptions" → not grill-me
- "pressure-test this" → not grill-me
- "review this and tell me what's wrong" → not grill-me
- "give me feedback" → not grill-me

## Workflow

### Step 0 — Understand the Subject

Read the plan, design, or idea the user has provided. If working in a codebase, explore relevant files before asking questions that can be answered by reading the code.

### Step 1 — Build the Decision Tree (silent)

Before asking the first question, mentally map:
- Core decisions already made (what's locked in)
- Branches that are open or unresolved
- Dependencies between decisions
- Unstated assumptions worth surfacing

### Step 2 — Interview Relentlessly

Ask one question at a time. For each question:
1. Ask the question
2. Provide your recommended answer with brief reasoning
3. Wait for the user's response before moving on

Work through branches systematically — exhaust one thread before opening another. When an answer reveals a new sub-question, follow it immediately.

**Question types to cycle through:**
- **Scope**: What's in? What's explicitly out?
- **Dependencies**: What does this depend on that isn't defined yet?
- **Failure modes**: What breaks first under load / edge cases / bad inputs?
- **Alternatives rejected**: Why this approach and not X?
- **Success criteria**: How will you know this worked?
- **Reversibility**: What's hard to undo? What's the rollback plan?
- **Ownership**: Who owns each part when something goes wrong?

### Step 3 — Resolve and Close

When all branches of the decision tree are resolved, summarize:
- Decisions confirmed
- Decisions changed or refined
- Open questions that remain (if any)
- Risks surfaced that need a mitigation plan

## Critical Rules

- NEVER ask more than one question per turn
- ALWAYS provide your recommended answer alongside the question
- If a question can be answered by exploring the codebase, explore it instead of asking
- Follow threads to completion before opening new ones
- Push back on weak reasoning — don't accept "it should be fine" as an answer
- Surface assumptions the user didn't state but is implicitly relying on

## Example Usage

1. "Grill me on my microservices migration plan"
2. "I want to stress-test this database schema before we build on it — grill me"
3. "We're about to kick off this project. Grill me on the architecture."
4. "I have a go-to-market plan. Pick it apart."
5. "Grill me on this carve-out strategy before I write the plan"
