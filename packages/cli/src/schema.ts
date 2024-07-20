import path from 'node:path';
import { getTriplitDir, loadTsModule } from './filesystem.js';
import fs from 'fs';
import { format } from 'prettier';
import {
  AttributeDefinition,
  CollectionsDefinition,
  CollectionDefinition,
  QueryAttributeDefinition,
  schemaToJSON,
  UserTypeOptions,
  Roles,
} from '@triplit/db';
import { blue } from 'ansis/colors';

export async function readLocalSchema() {
  const triplitDir = getTriplitDir();
  const schemaPath = path.join(triplitDir, 'schema.ts');
  const result = await loadTsModule(schemaPath);
  return result && result.schema ? result.schema : null;
}

export async function writeSchemaFile(
  fileContent: string,
  options: { path?: string } = {}
) {
  const fileName = path.join(options?.path || getTriplitDir(), 'schema.ts');
  fs.mkdirSync(path.dirname(fileName), { recursive: true });
  //use prettier as a fallback for formatting
  const formatted = await format(fileContent, { parser: 'typescript' });
  fs.writeFileSync(fileName, formatted, 'utf8');
  console.log(blue(`New schema has been saved at ${fileName}`));
}

export function schemaFileContentFromSchema(
  schema:
    | {
        roles?: Roles;
        version: number;
        collections: any;
      }
    | undefined
) {
  const schemaJSON = schemaToJSON(schema);
  return schemaFileContentFromJSON(schemaJSON);
}

export function schemaFileContentFromJSON(schemaJSON: any) {
  const schemaContent = collectionsDefinitionToFileContent(
    schemaJSON?.collections ?? {}
  );
  const rolesContent = schemaJSON?.roles ?? {};
  const fileContent =
    `
/**
 * This file is auto-generated by the Triplit CLI.
 */ 

import { Schema as S, Roles } from '@triplit/db';
export const roles: Roles = ${JSON.stringify(rolesContent, null, 2)};
export const schema = ${schemaContent};
      `.trim() + '\n';
  return fileContent;
}

// Generate a string representation of the schema that can be written to a file
const indentation = '  ';
export function collectionsDefinitionToFileContent(
  collectionsDefinition: CollectionsDefinition,
  indent = indentation
) {
  let result = '{\n';
  for (let collectionKey in collectionsDefinition) {
    result += indent;
    result += `'${collectionKey}': {\n`;
    const {
      schema: attributes,
      rules,
      permissions,
    } = collectionsDefinition[collectionKey];
    result += generateAttributesSection(attributes, indent + indentation);
    result += generateRulesSection(rules, indent + indentation);
    result += generatePermissionsSection(permissions, indent + indentation);
    result += indent + '},\n';
  }
  return result + indent.slice(0, -2) + '}';
}

function generateAttributesSection(
  schema: CollectionDefinition['schema'],
  indent: string
) {
  let result = '';
  result += indent + 'schema: S.Schema({\n';
  for (const path in schema.properties) {
    const itemInfo = schema.properties[path];
    const optional =
      schema.optional?.includes(
        // @ts-expect-error typescript trying to be too smart
        path
      ) ?? false;
    result += generateAttributeSchema(
      [path],
      { attribute: itemInfo, optional: optional },
      indent + indentation
    );
  }
  result += indent + '}),\n';
  return result;
}

function generateRulesSection(
  rules: CollectionDefinition['rules'],
  indent: string
) {
  let result = '';
  if (rules) {
    result +=
      indent +
      `rules: ${JSON.stringify(rules, null, 2)
        .split('\n')
        .join(`\n${indent}`)}`;
  }

  return result;
}

function generatePermissionsSection(
  permissions: CollectionDefinition['permissions'],
  indent: string
) {
  let result = '';
  if (permissions) {
    result +=
      indent +
      `permissions: ${JSON.stringify(permissions, null, 2)
        .split('\n')
        .join(`\n${indent}`)}`;
  }
  return result;
}

function generateAttributeSchema(
  path: string[],
  schemaItem: { attribute: AttributeDefinition; optional: boolean },
  indent: string
) {
  if (path.length === 0) return schemaItemToString(schemaItem);
  if (path.length === 1)
    return indent + `'${path[0]}': ${schemaItemToString(schemaItem)},\n`;
  let result = '';
  const [head, ...tail] = path;
  result += indent + `'${head}': {\n`;
  result += generateAttributeSchema(tail, schemaItem, indent + indentation);
  result += indent + '},\n';
  return result;
}

// TODO: parse options
// TODO: put on type classes?
function schemaItemToString(schemaItem: {
  attribute: AttributeDefinition;
  optional?: boolean;
}): string {
  const { attribute, optional } = schemaItem;
  const { type } = attribute;
  let result = '';
  switch (type) {
    case 'string':
      result = `S.String(${valueOptionsToString(attribute.options)})`;
      break;
    case 'boolean':
      result = `S.Boolean(${valueOptionsToString(attribute.options)})`;
      break;
    case 'number':
      result = `S.Number(${valueOptionsToString(attribute.options)})`;
      break;
    case 'date':
      result = `S.Date(${valueOptionsToString(attribute.options)})`;
      break;
    case 'set':
      result = `S.Set(${schemaItemToString({
        attribute: attribute.items,
      })},${valueOptionsToString(attribute.options)})`;
      break;
    case 'record':
      result = `S.Record({${Object.entries(attribute.properties)
        .map(([key, value]) => {
          const optional = attribute.optional?.includes(key) ?? false;
          return `'${key}': ${schemaItemToString({
            attribute: value,
            optional,
          })}`;
        })
        .join(',\n')}})`;
      break;
    case 'query':
      const { query, cardinality } = attribute;
      const { collectionName, ...queryParams } = query;
      if (cardinality === 'one') {
        const isRelationById =
          collectionName &&
          query.where &&
          query.where.length === 1 &&
          query.where[0][0] === 'id' &&
          query.where[0][1] === '=' &&
          Object.keys(queryParams).length === 1;
        if (isRelationById)
          result = `S.RelationById('${collectionName}', '${queryParams.where[0][2]}')`;
        else
          result = `S.RelationOne('${collectionName}',${subQueryToString(
            queryParams
          )})`;
      } else {
        result = `S.RelationMany('${collectionName}',${subQueryToString(
          queryParams
        )})`;
      }
      break;
    default:
      throw new Error(`Invalid type: ${type}`);
  }
  const excludeOptional = ['query'];
  if (!excludeOptional.includes(type))
    result = wrapOptional(result, optional ?? false);
  return result;
}

function wrapOptional(type: string, optional: boolean) {
  return optional ? `S.Optional(${type})` : type;
}

function valueOptionsToString(options: UserTypeOptions): string {
  const { nullable, default: defaultValue } = options;
  const result: string[] = [];
  if (nullable !== undefined) result.push(`nullable: ${nullable}`);
  if (defaultValue !== undefined)
    result.push(`default: ${defaultValueToString(defaultValue)}`);
  // wrap in braces if there are options
  if (result.length) return `{${result.join(', ')}}`;
  return '';
}

type Defined<T> = T extends undefined ? never : T;

function defaultValueToString(
  defaultValue: Defined<UserTypeOptions['default']>
): string {
  if (typeof defaultValue === 'object' && defaultValue !== null) {
    const { func, args } = defaultValue;
    // TODO: import list from db
    if (!['now', 'uuid'].includes(func))
      throw new Error('Invalid default function name');
    const parsedArgs = args ? args.map(valueToJS).join(', ') : '';
    return `S.Default.${func}(${parsedArgs})`;
  }

  return `${valueToJS(defaultValue)}`;
}

// Helpful for pulling out reserved words (ie default, return, etc)
function valueToJS(value: any) {
  if (typeof value === 'string') return `"${value}"`;
  if (typeof value === 'number') return `${value}`;
  if (typeof value === 'boolean') return `${value}`;
  if (value === null) return `null`;
  throw new Error(`Invalid value: ${value}`);
}

function subQueryToString(
  subquery: Omit<QueryAttributeDefinition['query'], 'collectionName'>
) {
  const { where, limit, order } = subquery;
  // const collectionNameString = collectionName
  //   ? `collectionName: '${collectionName}' as const`
  //   : '';
  const whereString = where ? `where: ${JSON.stringify(where)}` : '';
  const limitString = limit ? `limit: ${limit}` : '';
  const orderString = order ? `order: ${JSON.stringify(order)}` : '';
  const cleanedString = [
    // collectionNameString,
    whereString,
    limitString,
    orderString,
  ]
    .filter((str) => str)
    .join(', ');
  return `{${cleanedString}}`;
}
