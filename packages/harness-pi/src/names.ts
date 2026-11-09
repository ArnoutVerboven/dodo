/** pi's own tools dodo lets it bring. */
export const BUILTIN_TOOLS = ['read', 'edit', 'write', 'bash'] as const;

/** dodo's own tools these replace: the model sees one set of file tools, not two. */
export const REPLACED_TOOLS = ['bash', 'read_file', 'write_file', 'edit_file'];
