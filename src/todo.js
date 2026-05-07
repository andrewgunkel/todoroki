function Todo(title, description, dueDate, priority, notes, checklist, referenceLink, status) {
	this.title = title;
	this.description = description;
	this.dueDate = dueDate;
	this.priority = priority;
	this.notes = notes;
	this.checklist = checklist;
	this.referenceLink = referenceLink;
	this.status = status;
	this.id = self.crypto.randomUUID();
	this.createdAt = Date.now();
	this.updatedAt = Date.now();
	this.tags = [];
}

export { Todo };