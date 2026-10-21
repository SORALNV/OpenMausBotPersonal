// @vitest-environment happy-dom
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { Group } from "@/state/store";
const fixture=vi.hoisted(()=>({api:vi.fn(),dispatch:vi.fn()}));
vi.mock("@/state/store",()=>({api:fixture.api,useStore:()=>({state:{bots:[{id:"mail",name:"メール担当"},{id:"pi",name:"Pi",section:"端末管理部"}]},dispatch:fixture.dispatch})}));
const {GroupPermissionsPanel}=await import("./GroupPermissionsPanel");
afterEach(()=>{document.body.innerHTML="";vi.clearAllMocks()});
it("saves per-member permissions only after server confirmation, with a revision",async()=>{
 const group={id:"room",name:"ALL",memberIds:["mail","pi"],permissionsVersion:2} as Group;
 const host=document.createElement("div");document.body.append(host);const root=createRoot(host),close=vi.fn();
 flushSync(()=>root.render(createElement(GroupPermissionsPanel,{group,onClose:close})));
 expect(host.textContent).toContain("無所属");expect(host.textContent).toContain("端末管理部");
 const select=host.querySelector<HTMLSelectElement>('select[aria-label="メール担当 の応答方法"]')!;
 flushSync(()=>{select.value="always";select.dispatchEvent(new Event("change",{bubbles:true}))});
 const toggle=host.querySelector<HTMLInputElement>('input[type=checkbox]')!;
 flushSync(()=>toggle.click());
 fixture.api.mockResolvedValue({group:{...group,permissionsVersion:3}});
 const save=[...host.querySelectorAll("button")].find(b=>b.textContent==="設定を保存")!;
 flushSync(()=>save.click());
 await vi.waitFor(()=>expect(close).toHaveBeenCalledOnce());
 const body=JSON.parse(fixture.api.mock.calls[0][1].body);expect(body.permissionsVersion).toBe(2);expect(body.permissions.crossSection).toBe(true);expect(body.permissions.members.mail.response).toBe("always");
 expect(fixture.dispatch).toHaveBeenCalledWith({type:"groupPatched",group:expect.objectContaining({permissionsVersion:3})});root.unmount();
});
it("keeps the dialog open on a rejected or stale permission update",async()=>{
 const host=document.createElement("div");document.body.append(host);const root=createRoot(host),close=vi.fn();
 flushSync(()=>root.render(createElement(GroupPermissionsPanel,{group:{id:"room",name:"ALL",memberIds:["mail"]} as Group,onClose:close})));
 fixture.api.mockRejectedValue(new Error("設定を開き直してください"));
 flushSync(()=>[...host.querySelectorAll("button")].find(b=>b.textContent==="設定を保存")!.click());
 await vi.waitFor(()=>expect(host.querySelector('[role="alert"]')?.textContent).toContain("設定を開き直してください"));expect(close).not.toHaveBeenCalled();root.unmount();
});
