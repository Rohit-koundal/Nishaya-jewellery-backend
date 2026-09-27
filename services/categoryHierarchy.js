const Category = require('../models/Category');
const { andFilter } = require('./storeService');

const categoryId = (value) => String(value?._id || value || '');
const key = (value) => String(value || '').trim().toLowerCase();

function categoryPath(category, categories) {
  const byId = categories instanceof Map ? categories : new Map(categories.map((item) => [categoryId(item), item]));
  const path = [];
  const visited = new Set();
  let current = category;
  while (current && !visited.has(categoryId(current))) {
    visited.add(categoryId(current));
    path.unshift(current);
    current = byId.get(categoryId(current.parent));
  }
  return path;
}

function visibleCategories(categories) {
  const byId = new Map(categories.map((item) => [categoryId(item), item]));
  return categories.filter((category) => {
    const visited = new Set();
    let current = category;
    while (current) {
      const id = categoryId(current);
      if (visited.has(id) || current.isActive === false || current.isArchived) return false;
      visited.add(id);
      if (!current.parent) return true;
      current = byId.get(categoryId(current.parent));
    }
    return false; // Orphaned branches are not public navigation.
  });
}

function descendantIds(categories, selectedIds) {
  const children = new Map();
  for (const category of categories) {
    const parent = categoryId(category.parent);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(categoryId(category));
  }
  const result = new Set(selectedIds.map(categoryId).filter(Boolean));
  const queue = [...result];
  for (let index = 0; index < queue.length; index += 1) {
    for (const child of children.get(queue[index]) || []) {
      if (!result.has(child)) { result.add(child); queue.push(child); }
    }
  }
  return [...result];
}

function resolveCategoryIds(categories, values) {
  const selected = new Set(values.map(key));
  const ids = categories.filter((category) => [categoryId(category), category.name, category.slug, ...(category.previousSlugs || [])].some((alias) => selected.has(key(alias)))).map(categoryId);
  return descendantIds(categories, ids);
}

async function readCategoryHierarchy(tenantFilter, { publicOnly = false } = {}) {
  const categories = await Category.find(andFilter({}, tenantFilter)).select('_id name slug previousSlugs parent level displayOrder definitionKey isActive isArchived').lean();
  return publicOnly ? visibleCategories(categories) : categories;
}

module.exports = { categoryId, categoryPath, visibleCategories, descendantIds, resolveCategoryIds, readCategoryHierarchy };
