import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { OpenAI } from "openai";
import { OpenAIStream, StreamingTextResponse } from "ai";
import cors from "cors";
import bodyParser from "body-parser";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const openai = new OpenAI({
  apiKey: process.env["OPENAI_API_KEY"], // This is the default and can be omitted
});

// Jira API configuration
const JIRA_DOMAIN = process.env.JIRA_DOMAIN;
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;

// CORS configuration
const corsOptions = {
  origin: process.env.FRONTEND_URL || "http://127.0.0.1:5500/", // Adjust this to match your frontend URL
  methods: ["GET", "POST"],
};

app.use(cors(corsOptions));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
// Middleware to log request body
app.use((req, res, next) => {
  console.log("Request Body:", req.body);
  next();
});

async function getWorklogForIssue(issueKey) {
  const url = `https://${JIRA_DOMAIN}/rest/api/3/issue/${issueKey}/worklog`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Basic ${Buffer.from(
        `${JIRA_EMAIL}:${JIRA_API_TOKEN}`
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

  try {
    const jqlQuery = encodeURIComponent(
      `assignee = "${username}" AND status != Done ORDER BY updated DESC`
    );
    const url = `https://${JIRA_DOMAIN}/rest/api/3/search?jql=${jqlQuery}&expand=names,schema`;

    console.log("Requesting URL:", url);

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${JIRA_EMAIL}:${JIRA_API_TOKEN}`
        ).toString("base64")}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();

    // Extract start and end dates, and fetch worklog for each issue
    const tasksWithDetails = await Promise.all(
      data.issues.map(async (issue) => {
        let startDate = null;
        let endDate = null;
        let estimatedHours = 0;

        // Loop through custom fields to find start and end dates
        Object.entries(issue.fields).forEach(([fieldId, fieldValue]) => {
          const fieldName = data.names[fieldId];
          if (fieldName === "Actual start" && fieldValue) {
            startDate = fieldValue;
          } else if (fieldName === "Due date" && fieldValue) {
            endDate = fieldValue;
          }
        });

        // Get estimated time
        if (issue.fields.timeoriginalestimate) {
          estimatedHours = issue.fields.timeoriginalestimate / 3600; // Convert seconds to hours
        }

        // Fetch worklog for the issue
        const worklog = await getWorklogForIssue(issue.key);

        // Calculate total logged hours
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

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
