/**
 * This file is auto-generated by the Triplit CLI.
 */

import { Schema as S, Roles } from '@triplit/client';
export const roles: Roles = {};
export const schema = {
  test: {
    schema: S.Schema({
      id: S.String({ nullable: false, default: S.Default.uuid() }),
      attr: S.String(),
    }),
  },
};
