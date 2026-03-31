# Automated PR Review Agents

Multi-agent PR review system using `claude-code-action` in GitHub Actions. Each PR is reviewed in parallel by four independent agents, each with full access to the checked-out repository.

## How it works

```
PR opened / pushed
       |
       v
+---------------------------+
|  pr-review.yml workflow   |
|  (matrix: 4 agents)      |
+----+--+--+--+-------------+
     |  |  |  |
     v  v  v  v
   [A][S][B][Q]              Each job runs claude-code-action
     |  |  |  |              with a different review prompt
     v  v  v  v
   LiteLLM proxy             Routes to configured model per agent
     |  |  |  |
     v  v  v  v
   PR comments               Posted as comments on the PR
```

**A** = Architecture, **S** = Security, **B** = Breaking Changes, **Q** = Code Quality

## Key difference from a simple "send diff to API" approach

Each agent is autonomous — it doesn't just see the diff. It:
- Reads the full repository (checked out on the runner)
- Reads `CLAUDE.md` for project conventions automatically
- Follows imports to understand context around changed code
- Checks for related test files
- Decides what additional files to read based on the diff
- Posts comments on the PR

## File layout

```
.github/
+-- pr-review-agents/
|   +-- README.md               <-- You are here
|   +-- architecture.md         Layer boundaries, dependency direction, DCB patterns
|   +-- security.md             SQL/DynamoDB injection, input validation, concurrency
|   +-- breaking-changes.md     API changes, removed exports, type narrowing
|   +-- code-quality.md         Bugs, duplication, concurrency correctness
+-- workflows/
    +-- pr-review.yml           PR review workflow
```

## Agent prompts

Each `.md` file in `pr-review-agents/` defines a review perspective. Prompts are tailored to the DCB event store's architecture — package boundaries, EventStore interface, Tag/Query model, SequencePosition opacity, and adapter separation.

Prompts are version-controlled and PR-able. To tune review focus, edit the relevant markdown file.

## Per-agent model selection

Models are configured per agent in the workflow matrix:

```yaml
matrix:
  include:
    - agent: architecture
      model: claude-opus-4-6       # Complex, nuanced review
    - agent: security
      model: claude-sonnet-4-6     # Faster, pattern-matching
    - agent: breaking-changes
      model: claude-sonnet-4-6
    - agent: code-quality
      model: claude-sonnet-4-6
```

## Required secrets and variables

| Name | Type | Purpose |
|------|------|---------|
| `LITELLM_API_KEY` | Secret | Authentication token for LiteLLM proxy |
| `LITELLM_BASE_URL` | Variable | LiteLLM endpoint (set as `ANTHROPIC_BASE_URL`) |
| `GITHUB_TOKEN` | Secret | Provided automatically by GitHub Actions |

## Adding a new review agent

1. Create `.github/pr-review-agents/<name>.md` with the review prompt
2. Add an entry to the matrix in `.github/workflows/pr-review.yml`:
   ```yaml
   - agent: <name>
     model: claude-sonnet-4-6
   ```
