import {describe,expect,it}from"vitest";
import{groupTranscript}from"./activity-runs";
import type{Message}from"@/state/store";

describe("native OhMyPi progress display",()=>{
 it("shows progress during execution and folds it behind the final answer using the normal chat protocol",()=>{
  const progress:Message={id:"progress",at:1,role:"bot",kind:"text",text:"Pi / OhMyPi の途中経過\nファイルの確認を進めています。",requestMessageId:"user",turnId:"omp-user"};
  const narration:Message={id:"narration",at:2,role:"bot",kind:"text",text:"接続を確認しました。次にテストします。",requestMessageId:"user",turnId:"omp-user"};
  const final:Message={id:"final",at:3,role:"bot",kind:"text",text:"検証が完了しました。",requestMessageId:"user",turnId:"omp-user",turnTerminal:true,turnSucceeded:true};
  expect(groupTranscript([progress,narration]).map(row=>row.kind)).toEqual(["message","message"]);
  const settled=groupTranscript([progress,narration,final]);
  expect(settled.map(row=>row.kind)).toEqual(["turn","message"]);
  expect(settled[0]).toMatchObject({kind:"turn",messages:[progress,narration]});
  expect(settled[1]).toEqual({kind:"message",message:final});
 });
 it("keeps high-risk operation receipts visible after final narration is folded",()=>{
  const progress:Message={id:"p",at:1,role:"bot",kind:"text",text:"検証中",turnId:"omp-u"};
  const audit:Message={id:"a",at:2,role:"bot",kind:"options",card:{title:"実行記録",subtitle:"状態: 実行開始を確認",options:[],tool:"OhMyPi/bash",requestId:"native-omp-audit-a",requestType:"permission",answered:"allow"}};
  const final:Message={id:"f",at:3,role:"bot",kind:"text",text:"完了",turnId:"omp-u",turnTerminal:true};
  const rows=groupTranscript([progress,audit,final]);
  expect(rows).toContainEqual({kind:"message",message:audit});
 });
});
