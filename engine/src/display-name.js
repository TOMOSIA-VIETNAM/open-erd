// How a database name reads in titles (frames, breadcrumb, menus): first
// letter upper case. Display only; ids, data attributes and files keep the
// name as written in the model.
export const dbDisplayName = (name) => (name ? name[0].toUpperCase() + name.slice(1) : name);
