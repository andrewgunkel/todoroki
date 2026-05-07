function Project(title, description) {
    this.title = title;
    this.description = description;
    this.id = self.crypto.randomUUID();
    this.todos = [];

}


//const Project {}


Project.prototype.addTodo = function(todo) {
    if (!this.todoCounter) this.todoCounter = 0;
    this.todoCounter++;
    todo.number = this.todoCounter;
    this.todos.push(todo);
}

Project.prototype.removeTodo = function(id) {
    this.todos = this.todos.filter(todo => todo.id !== id);
};

Project.prototype.editTodo = function(id, updatedFields) {
	const todo = this.todos.find(todo => todo.id === id);

	if (!todo) return;

	Object.assign(todo, updatedFields);
	todo.updatedAt = Date.now();
};

//Project.prototype.removeTodo

//internal projects[]

//addProject

//removeProject

//getProject

export { Project };