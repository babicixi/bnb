import type {
  Id,
  InternalTask,
  RoleName,
  TaskPriority,
  TaskStatus,
} from "../domain/types.js";

export interface TaskSink {
  set(id: Id, task: InternalTask): void;
  get(id: Id): InternalTask | undefined;
  values(): IterableIterator<InternalTask>;
}

export interface CreateTaskInput {
  id: Id;
  title: string;
  description?: string;
  relatedEntityType?: string;
  relatedEntityId?: Id;
  assignedRole?: RoleName;
  assignedUserId?: Id;
  priority?: TaskPriority;
  dueAt?: Date;
  createdByUserId?: Id;
  now?: Date;
}

export function createTask(
  sink: TaskSink,
  input: CreateTaskInput,
): InternalTask {
  const now = input.now ?? new Date();
  const task: InternalTask = {
    id: input.id,
    title: input.title,
    description: input.description,
    relatedEntityType: input.relatedEntityType,
    relatedEntityId: input.relatedEntityId,
    assignedRole: input.assignedRole,
    assignedUserId: input.assignedUserId,
    priority: input.priority ?? "normal",
    dueAt: input.dueAt,
    status: "open",
    createdByUserId: input.createdByUserId,
    createdAt: now,
    updatedAt: now,
  };
  sink.set(task.id, task);
  return task;
}

export function transitionTask(
  task: InternalTask,
  next: TaskStatus,
  now = new Date(),
  notes?: string,
): InternalTask {
  task.status = next;
  task.updatedAt = now;
  if (next === "completed") task.completedAt = now;
  if (notes) task.notes = notes;
  return task;
}
