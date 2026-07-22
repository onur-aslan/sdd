# PRD Template

Generate the following file at `docs/sdd/features/<feature-name>/prd.md`:

```markdown
# PRD: [Feature Name]

| Metadata | Value |
|----------|-------|
| Status | Draft / In Review / Approved |
| Version | 1.0 |
| Created | YYYY-MM-DD |
| Owner | [Product Owner / Team] |

---

## 1. Executive Summary

[2-3 sentences summarizing what this feature does and why it matters. Written for executives/stakeholders who won't read the full document.]

---

## 2. Problem Statement

[What user problem or business need does this feature address? Include current pain points and impact.]

### 2.1 Current State
[Describe the current situation without this feature]

### 2.2 Desired State
[Describe the desired situation after this feature is delivered]

---

## 3. Goals & Objectives

### 3.1 Primary Goals
- [Goal 1: Measurable outcome]
- [Goal 2: Measurable outcome]

### 3.2 Non-Goals
[What this feature explicitly does NOT do - important for scope management]

---

## 4. Success Metrics

[How will you measure if this feature is successful? Include baseline, target, and time horizon.]

| Metric | Baseline | Target | Time Horizon | Measurement Method |
|--------|----------|--------|--------------|-------------------|
| [Metric name] | [Current value] | [Target value] | [Timeframe] | [How you'll measure] |

---

## 5. User Stories

| ID | User Story | Acceptance Criteria | Priority |
|----|------------|---------------------|----------|
| US-01 | As a [user], I want to [action], so that [benefit] | - [Criterion 1]<br>- [Criterion 2] | Must have / Should have / Could have |
| US-02 | As a [user], I want to [action], so that [benefit] | - [Criterion 1]<br>- [Criterion 2] | Must have / Should have / Could have |

---

## 6. Functional Requirements

| ID | Requirement | Description | Priority | Dependencies |
|----|-------------|-------------|----------|--------------|
| FR-01 | [Title] | [What the system must do] | P0 / P1 / P2 | [Related FR IDs or external deps] |
| FR-02 | [Title] | [What the system must do] | P0 / P1 / P2 | [Related FR IDs or external deps] |

---

## 7. Non-Functional Requirements

### 7.1 Performance
- [Response time, throughput, latency requirements]

### 7.2 Security
- [Authentication, authorization, data protection requirements]

### 7.3 Reliability & Availability
- [Uptime, error rate, recovery requirements]

### 7.4 Scalability
- [User load, data volume growth expectations]

### 7.5 Accessibility
- [WCAG compliance level, assistive technology support]

---

## 8. User Experience & Design

### 8.1 Wireframes / Mockups
[Link to or embed visual designs, or describe key UI states]

### 8.2 Content & Messaging
[Key copy, tone, localization requirements]

---

## 9. Technical Considerations

[High-level technical approach translated from spec.md design decisions - written for technical stakeholders, not implementation detail]

### 9.1 Integration Points
[External APIs, services, or systems this feature touches]

### 9.2 Technical Constraints
[Hard constraints from the spec that affect product decisions]

---

## 10. Open Questions

| ID | Question | Context | Decision Needed By | Owner |
|----|----------|---------|-------------------|-------|
| Q-01 | [Unresolved question] | [Why it matters] | [Date/milestone] | [Role] |
```

---