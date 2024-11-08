import express from "express";
import { openai } from "@ai-sdk/openai";
import { streamText, generateText } from "ai";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = 3000;

app.use(express.json());
app.use(express.static("public"));

let conversationHistory = [];
let lastUsedName = { username: "", fullName: "" };

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

async function getWorklogForIssue(issueKey) {
  const url = `https://${process.env.JIRA_DOMAIN}/rest/api/3/issue/${issueKey}/worklog`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Basic ${Buffer.from(
        `${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`
      ).toString("base64")}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const data = await response.json();
  return data.worklogs;
}

app.get("/tasks", async (req, res) => {
  const { username } = req.query;

  if (!username) {
    return res.status(400).json({ error: "Username is required" });
  }

  console.log(username, "username");

  try {
    const jqlQuery = encodeURIComponent(
      `assignee = "${username}" AND status != Done ORDER BY updated DESC`
    );
    const url = `https://${process.env.JIRA_DOMAIN}/rest/api/3/search?jql=${jqlQuery}&expand=names,schema`;

    console.log("Requesting URL:", url);

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`
        ).toString("base64")}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    const tasksWithDetails = await Promise.all(
      data.issues.map(async (issue) => {
        let startDate = null;
        let endDate = null;
        let estimatedHours = 0;

        Object.entries(issue.fields).forEach(([fieldId, fieldValue]) => {
          const fieldName = data.names[fieldId];
          if (fieldName === "Actual start" && fieldValue) {
            startDate = fieldValue;
          } else if (fieldName === "Due date" && fieldValue) {
            endDate = fieldValue;
          }
        });

        if (issue.fields.timeoriginalestimate) {
          estimatedHours = issue.fields.timeoriginalestimate / 3600;
        }

        const worklog = await getWorklogForIssue(issue.key);

        const loggedHours = worklog.reduce((total, entry) => {
          return total + entry.timeSpentSeconds / 3600;
        }, 0);

        return {
          key: issue.key,
          summary: issue.fields.summary,
          startDate,
          endDate,
          estimatedHours: parseFloat(estimatedHours.toFixed(2)),
          loggedHours: parseFloat(loggedHours.toFixed(2)),
        };
      })
    );

    res.json(tasksWithDetails);
  } catch (error) {
    console.error("Error fetching Jira tasks:", error);
    res.status(500).json({ error: "Failed to fetch Jira tasks" });
  }
});

function extractName(message) {
  const fullNameMatch = message.match(
    /(?:name is|full name is|call me) ([\w\s]+)/i
  );
  const usernameMatch = message.match(/(?:username is|user is) (\w+)/i);
  const assignedToMatch = message.match(
    /(?:get ticket(?:s)? assigned to|show me tasks for user) ([\w\s]+)/i
  );

  if (fullNameMatch) {
    return { fullName: fullNameMatch[1].trim(), username: "" };
  } else if (usernameMatch) {
    return { fullName: "", username: usernameMatch[1].trim() };
  } else if (assignedToMatch) {
    const name = assignedToMatch[1].trim();
    if (name.includes(" ")) {
      return { fullName: name, username: "" };
    } else {
      return { fullName: "", username: name };
    }
  }
  return null;
}

app.post("/chat", async (req, res) => {
  const { message } = req.body;

  if (!message) {
    return res.status(400).json({ error: "Message is required" });
  }

  try {
    // Check if the message contains a new name
    const extractedName = extractName(message);
    if (extractedName) {
      lastUsedName = extractedName;
    }

    // Determine which name to use for fetching tasks
    const nameToUse = lastUsedName.fullName || lastUsedName.username;

    console.log("Current lastUsedName:", lastUsedName);
    console.log("Name being used for tasks:", nameToUse);

    // Fetch tasks for the name
    let tasks = [];
    if (nameToUse) {
      const tasksUrl = `http://localhost:${port}/tasks?username=${encodeURIComponent(
        nameToUse
      )}`;
      const tasksResponse = await fetch(tasksUrl);
      if (tasksResponse.ok) {
        tasks = await tasksResponse.json();
      }
    }

    // Analyze the query and tasks
    const analysis = await analyzeQuery(message, tasks, lastUsedName);

    // Stream the response
    res.setHeader("Content-Type", "text/plain");
    res.setHeader("Transfer-Encoding", "chunked");

    for (const chunk of analysis) {
      res.write(chunk);
    }

    res.end();
  } catch (error) {
    console.error("Error:", error);
    res
      .status(500)
      .json({ error: "An error occurred while processing your request" });
  }
});

async function analyzeQuery(userInput, taskData, lastUsedName) {
  const assigneeName = lastUsedName.fullName || lastUsedName.username;
  const isRiskAnalysisRequested = userInput.toLowerCase().includes("risk");

  const systemPrompt = `
    You are an AI assistant designed to analyze JIRA tickets. Your task is to:

    1. Always provide a summary of the tickets assigned to ${assigneeName}.
    2. If specifically requested, perform a risk analysis for delayed delivery.

    For the risk analysis, evaluate each ticket based on:
    • Assignee: Confirm it's assigned to ${assigneeName}.
    • Start Date: Check if it started on time relative to the due date.
    • Due Date: Assess if it's approaching and if the ticket is on track.
    • Original Estimate vs. Logged Hours: Check if logged hours exceed the estimate.

    For each ticket in the risk analysis, provide:
    1. A brief assessment based on the above parameters.
    2. A risk level (High Risk, At Risk, or On Track).
    3. Recommendations if the ticket appears at risk.

    Keep your responses concise and relevant to the user's query.
  `;

  try {
    const result = await generateText({
      model: openai("gpt-4-turbo"),
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `User query: ${userInput}. Task data: ${JSON.stringify(
            taskData
          )}. ${
            isRiskAnalysisRequested
              ? "Perform a risk analysis."
              : "Provide only a summary of the tickets."
          }`,
        },
      ],
    });

    return result.text.trim();
  } catch (error) {
    console.error("Error analyzing query:", error);
    return "An error occurred while analyzing the query.";
  }
}

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});

// Create the public directory and the HTML file
const publicDir = path.join(__dirname, "public");
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir);
}

const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Jira Tasks Chat</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
        #chat-container { border: 1px solid #ccc; height: 400px; overflow-y: scroll; padding: 10px; margin-bottom: 20px; }
        #user-input { width: 70%; padding: 10px; }
        #send-button { padding: 10px 20px; }
        pre { white-space: pre-wrap; word-wrap: break-word; }
    </style>
</head>
<body>
    <h1>Jira Tasks Chat</h1>
    <div id="chat-container"></div>
    <input type="text" id="user-input" placeholder="Type your message...">
    <button id="send-button">Send</button>

    <script>
        const chatContainer = document.getElementById('chat-container');
        const userInput = document.getElementById('user-input');
        const sendButton = document.getElementById('send-button');

        function addMessage(role, content) {
            const messageElement = document.createElement('div');
            messageElement.innerHTML = '<strong>' + role + ':</strong> <pre>' + content + '</pre>';
            chatContainer.appendChild(messageElement);
            chatContainer.scrollTop = chatContainer.scrollHeight;
        }

        async function sendMessage() {
            const message = userInput.value.trim();
            if (message) {
                addMessage('You', message);
                userInput.value = '';

                try {
                    const response = await fetch('/chat', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({ message }),
                    });

                    if (response.ok) {
                        const reader = response.body.getReader();
                        const decoder = new TextDecoder();
                        let assistantResponse = '';

                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            assistantResponse += decoder.decode(value);
                        }
                        addMessage('Assistant', assistantResponse.trim());
                    } else {
                        console.error('Error:', response.statusText);
                        addMessage('System', 'An error occurred while processing your request.');
                    }
                } catch (error) {
                    console.error('Error:', error);
                    addMessage('System', 'An error occurred while sending your message.');
                }
            }
        }

        sendButton.addEventListener('click', sendMessage);
        userInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                sendMessage();
            }
        });
    </script>
</body>
</html>
`;

fs.writeFileSync(path.join(publicDir, "index.html"), htmlContent);

console.log("HTML file created successfully.");
