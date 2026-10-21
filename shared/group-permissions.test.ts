import { describe, expect, it } from "vitest";
import { groupCanSpeak, groupCrossSection, groupMemberPermissions, parseGroupPermissions, permittedGroupResponders, DEFAULT_GROUP_MEMBER_PERMISSIONS as defaults } from "./group-permissions.ts";
const a={id:"a"},b={id:"b"},c={id:"c"};
describe("owner-defined group permissions",()=>{
 it("retains legacy routing and requires an explicit cross-section grant",()=>{
  const room={memberIds:["a","b"]};expect(groupCrossSection(room)).toBe(false);expect(groupCanSpeak(room,"outsider")).toBe(false);expect(groupMemberPermissions(room,"a")).toEqual(defaults);
  expect(permittedGroupResponders(room,[a,b],[a],[])).toEqual([a]);
 });
 it("routes always, mentioned-only and read-only members independently",()=>{
  const room={memberIds:["a","b","c"],permissions:{crossSection:true,members:{a:{...defaults,response:"always" as const},b:{...defaults,response:"mentions" as const},c:{...defaults,response:"off" as const}}}};
  expect(permittedGroupResponders(room,[a,b,c],[c],[])).toEqual([a]);
  expect(permittedGroupResponders(room,[a,b,c],[c],[b,c])).toEqual([a,b]);expect(groupCrossSection(room)).toBe(true);
 });
 it("rejects unknown members, unknown grants and invalid boolean permissions",()=>{
  const valid={crossSection:true,members:{a:{...defaults}}};expect(parseGroupPermissions(valid,["a"])).toEqual(valid);
  for(const value of [{...valid,crossSection:"true"},{...valid,members:{outsider:defaults}},{...valid,members:{a:{...defaults,post:"yes"}}},{...valid,admin:true},{...valid,members:{a:{...defaults,execute:true}}}])expect(()=>parseGroupPermissions(value,["a"])).toThrow();
 });
});
