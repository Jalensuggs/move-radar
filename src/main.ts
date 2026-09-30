// 一个进程跑两件事：调度（抓取、判断、行情、归因）和网页。
// AIHOT 拆成 api / worker / web 三个进程；Demo 规模合在一起，模块边界不变，以后要拆只改这个文件。
import { startServer } from "./server.ts";
import { startWorker } from "./worker.ts";
import { llmStatus } from "./llm.ts";

const llm = llmStatus();
console.log(llm.enabled ? `模型：${llm.provider} / ${llm.model}（来自 ${llm.source === "settings" ? "页面设置" : ".env"}）` : `规则模式（${llm.reason}）——在页面右上角「AI 设置」里填 API Key 就能改用模型`);
startServer();
if (process.env.WORKER !== "off") startWorker();
