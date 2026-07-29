import fs from "fs";

export function writePromptToFile(prompt, filePath = "./prompt_dump.txt") {
  fs.writeFileSync(filePath, prompt, "utf8");
}