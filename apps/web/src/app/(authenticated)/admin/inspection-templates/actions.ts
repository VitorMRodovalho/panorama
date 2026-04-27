'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

const CORE_API = process.env.CORE_API_URL ?? 'http://localhost:4000';

async function cookieHeader(): Promise<string> {
  const jar = await cookies();
  return jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

interface TemplateItemInput {
  label: string;
  itemType: 'BOOLEAN' | 'TEXT' | 'NUMBER' | 'PHOTO';
  required: boolean;
  photoRequired: boolean;
  minValue?: number;
  maxValue?: number;
  helpText?: string;
}

/**
 * Reads `items[N][field]` form fields produced by the create-form
 * page. Iterates 0..MAX-1, drops rows whose label is empty (treats
 * those as "unused slot"). Skipping is forgiving so admins don't
 * need to fill every row.
 */
const MAX_ITEM_ROWS = 50;

function parseItems(formData: FormData): TemplateItemInput[] {
  const items: TemplateItemInput[] = [];
  for (let i = 0; i < MAX_ITEM_ROWS; i++) {
    const label = String(formData.get(`items[${i}][label]`) ?? '').trim();
    if (!label) continue;
    const itemType = String(formData.get(`items[${i}][itemType]`) ?? 'BOOLEAN') as
      | 'BOOLEAN'
      | 'TEXT'
      | 'NUMBER'
      | 'PHOTO';
    const item: TemplateItemInput = {
      label,
      itemType,
      required: formData.get(`items[${i}][required]`) === 'on',
      photoRequired: formData.get(`items[${i}][photoRequired]`) === 'on',
    };
    if (itemType === 'NUMBER') {
      const minRaw = String(formData.get(`items[${i}][minValue]`) ?? '').trim();
      const maxRaw = String(formData.get(`items[${i}][maxValue]`) ?? '').trim();
      if (minRaw) item.minValue = Number(minRaw);
      if (maxRaw) item.maxValue = Number(maxRaw);
    }
    const help = String(formData.get(`items[${i}][helpText]`) ?? '').trim();
    if (help) item.helpText = help;
    items.push(item);
  }
  return items;
}

function fmtError(raw: string): string {
  const e = raw.toLowerCase();
  if (e.includes('category_scope_must_be_kind_xor_id'))
    return 'Pick exactly one scope: either a category kind OR a specific category, not both.';
  if (e.includes('items_min_1')) return 'Add at least one item.';
  if (e.includes('items_max_50')) return 'Max 50 items per template.';
  if (e.includes('numeric_bounds_only_for_number'))
    return 'Min/max bounds only apply to NUMBER items.';
  if (e.includes('minvalue_must_be_le_maxvalue')) return 'Min must be ≤ Max.';
  if (e.includes('inspection_template_archived')) return 'This template is archived.';
  if (e.includes('inspection_template_not_found')) return 'Template not found.';
  if (e.includes('admin_role_required')) return 'Admin role required.';
  if (e.includes('category_not_found')) return 'Category not found in this tenant.';
  return raw;
}

// ---------------------------------------------------------------------
// create
// ---------------------------------------------------------------------

export async function createTemplateAction(formData: FormData): Promise<void> {
  const name = String(formData.get('name') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim() || undefined;
  const scopeKind = String(formData.get('scope') ?? '').trim();
  const categoryKind = scopeKind === 'kind' ? String(formData.get('categoryKind') ?? '').trim() || undefined : undefined;
  const categoryId = scopeKind === 'category' ? String(formData.get('categoryId') ?? '').trim() || undefined : undefined;
  const displayOrderRaw = String(formData.get('displayOrder') ?? '0').trim();
  const displayOrder = Number(displayOrderRaw) || 0;
  const items = parseItems(formData);

  if (!name) {
    redirect('/admin/inspection-templates/new?error=' + encodeURIComponent('Name is required.'));
  }
  if (items.length === 0) {
    redirect('/admin/inspection-templates/new?error=' + encodeURIComponent('Add at least one item.'));
  }
  if (!categoryKind && !categoryId) {
    redirect('/admin/inspection-templates/new?error=' + encodeURIComponent('Pick a scope.'));
  }

  const body: Record<string, unknown> = {
    name,
    displayOrder,
    items,
  };
  if (description) body.description = description;
  if (categoryKind) body.categoryKind = categoryKind;
  if (categoryId) body.categoryId = categoryId;

  const res = await fetch(`${CORE_API}/inspection-templates`, {
    method: 'POST',
    headers: { cookie: await cookieHeader(), 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(body),
  });

  if (res.status === 201) {
    redirect('/admin/inspection-templates?created=1');
  }
  const payload = (await res.json().catch(() => ({ message: 'error' }))) as { message?: string };
  redirect(
    '/admin/inspection-templates/new?error=' +
      encodeURIComponent(fmtError(payload.message ?? 'error')),
  );
}

// ---------------------------------------------------------------------
// archive — soft delete
// ---------------------------------------------------------------------

export async function archiveTemplateAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '').trim();
  if (!id) redirect('/admin/inspection-templates');

  const res = await fetch(`${CORE_API}/inspection-templates/${id}`, {
    method: 'DELETE',
    headers: { cookie: await cookieHeader() },
    cache: 'no-store',
  });

  if (res.status === 204) {
    redirect('/admin/inspection-templates?archived=1');
  }
  const payload = (await res.json().catch(() => ({ message: 'error' }))) as { message?: string };
  redirect(
    '/admin/inspection-templates?error=' + encodeURIComponent(fmtError(payload.message ?? 'error')),
  );
}
