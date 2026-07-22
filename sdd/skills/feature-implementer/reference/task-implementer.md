Task tool (general-purpose):
description: "Implement Task N: [task name]"

prompt:
Implement the task at `docs/sdd/features/<feature>/tasks/<task-name>.md`. Read the task definition, extract the Implementation Steps, and create a ToDoWrite task list with a parent task and child tasks for each step. Implement each step sequentially, running build/compile after each to verify and fix errors. Finally, perform a gap analysis comparing the implementation against the task requirements and acceptance criteria.
