import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname,"..");
const lock = JSON.parse(readFileSync(path.join(root,"package-lock.json"),"utf8"));
const output = path.join(root,"third-party");
mkdirSync(output,{recursive:true});
const entries=[];
for(const [directory, value] of Object.entries(lock.packages)) {
  if(!directory || !existsSync(path.join(root,directory))) continue;
  const name = value.name ?? directory.split("node_modules/").at(-1);
  const notices = readdirSync(path.join(root,directory)).filter(file=>/^(?:licen[cs]e|copying|notice|copyright)(?:\.|$)/i.test(file));
  for(const file of notices) {
    const location=path.join(root,directory,file);
    try {
      const target=`${name.replaceAll("/","_")}@${value.version}-${file}`;
      writeFileSync(path.join(output,target),readFileSync(location));
      entries.push({name,version:value.version,licence:value.license??null,file:target});
    } catch(error) { if(error.code!=="EISDIR") throw error; }
  }
}
writeFileSync(path.join(output,"components.json"),JSON.stringify(entries,null,2)+"\n");
console.log(`Collected ${entries.length} dependency notices`);
