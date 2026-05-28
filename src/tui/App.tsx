import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import {
  Orchestrator,
  OrchestratorEvent,
  scanProjectFiles,
  parseAgentOptions,
} from "../core/orchestrator.js";
import { ServerManager, ModelConfig } from "../opencode/server.js";
import {
  FlowcodeConfig,
  StageConfig,
  FlowcodeState,
  StageReport,
  Checklist,
} from "../config/schema.js";
import {
  loadConfig,
  listAvailableFlows,
  loadState,
  initDefaultConfig,
  configExists,
  resetFlowcodeDir,
} from "../config/loader.js";
import { loadAllReports } from "../core/report.js";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function useSpinner(active: boolean): string {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(timer);
  }, [active]);
  return active ? SPINNER_FRAMES[frame] : "";
}

interface ArrowOption {
  label: string;
  value: string;
}

interface ArrowSelectProps {
  options: ArrowOption[];
  onSelect: (value: string) => void;
  selectedIndex: number;
  onSelectedChange: (index: number) => void;
}

function ArrowSelect({ options, onSelect, selectedIndex, onSelectedChange }: ArrowSelectProps) {
  useInput((input, key) => {
    if (key.upArrow) {
      onSelectedChange(Math.max(0, selectedIndex - 1));
    }
    if (key.downArrow) {
      onSelectedChange(Math.min(options.length - 1, selectedIndex + 1));
    }
    if (key.return) {
      onSelect(options[selectedIndex].value);
    }
  });

  return (
    <Box flexDirection="column">
      {options.map((opt, i) => (
        <Box key={opt.value}>
          <Text
            color={i === selectedIndex ? "cyan" : undefined}
            bold={i === selectedIndex}
            backgroundColor={i === selectedIndex ? "gray" : undefined}
          >
            {i === selectedIndex ? " > " : "   "}{opt.label}
          </Text>
        </Box>
      ))}
      <Text dimColor> Up/Down to select, Enter to confirm</Text>
    </Box>
  );
}

interface FlowSelectorProps {
  config: FlowcodeConfig;
  onSelect: (flowName: string) => void;
}

function FlowSelector({ config, onSelect }: FlowSelectorProps) {
  const flows = listAvailableFlows(config);
  const [selected, setSelected] = useState(0);

  const options = flows.map((f) => ({
    label: `${f.displayName} (${f.stageCount} stages)`,
    value: f.name,
  }));

  return (
    <Box flexDirection="column" padding={1}>
      <Box borderStyle="round" borderColor="magenta" paddingX={2} marginBottom={1}>
        <Text bold color="magenta">FLOWCODE</Text>
        <Text> - Select a flow to start</Text>
      </Box>
      <ArrowSelect
        options={options}
        onSelect={onSelect}
        selectedIndex={selected}
        onSelectedChange={setSelected}
      />
    </Box>
  );
}

interface StageProgressProps {
  stages: StageConfig[];
  currentIndex: number;
  stageActive: boolean;
}

function StageProgress({ stages, currentIndex, stageActive }: StageProgressProps) {
  const spinner = useSpinner(stageActive);

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">Pipeline</Text>
      {stages.map((stage, i) => {
        let icon: string;
        let color: string | undefined;
        if (i < currentIndex) {
          icon = "✓";
          color = "green";
        } else if (i === currentIndex) {
          icon = stageActive ? spinner : "►";
          color = "yellow";
        } else {
          icon = "○";
          color = undefined;
        }
        return (
          <Box key={stage.id}>
            <Text color={color} bold={i === currentIndex}>
              {" "}
              {icon} {stage.name}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

interface FileAutocompleteProps {
  query: string;
  selectedIndex: number;
  onSelect: (path: string) => void;
  visible: boolean;
}

function FileAutocomplete({ query, selectedIndex, onSelect, visible }: FileAutocompleteProps) {
  const [files, setFiles] = useState<string[]>([]);

  useEffect(() => {
    if (!visible || query.length === 0) {
      setFiles([]);
      return;
    }
    const results = scanProjectFiles(query, 8);
    setFiles(results);
  }, [query, visible]);

  if (!visible || files.length === 0) return null;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
      {files.slice(0, 6).map((file, i) => (
        <Text key={file} color={i === selectedIndex ? "cyan" : undefined} bold={i === selectedIndex}>
          {i === selectedIndex ? " > " : "   "}{file}
        </Text>
      ))}
      {files.length > 6 && (
        <Text dimColor>   ...and {files.length - 6} more</Text>
      )}
    </Box>
  );
}

interface ChatOutputProps {
  messages: Array<{ role: "user" | "agent" | "system" | "tool"; text: string; options?: string[] }>;
  maxLines: number;
}

function ChatOutput({ messages, maxLines }: ChatOutputProps) {
  const { stdout } = useStdout();
  const visibleMessages = messages.slice(-maxLines);

  return (
    <Box flexDirection="column">
      {visibleMessages.map((msg, i) => {
        if (msg.role === "user") {
          return (
            <Box key={i} flexDirection="column">
              <Box>
                <Text bold color="blue">You: </Text>
                <Text wrap="wrap">{msg.text.slice(0, 200)}</Text>
              </Box>
            </Box>
          );
        }
        if (msg.role === "agent") {
          const cleanText = msg.options
            ? msg.text.replace(/\n?OPTIONS:\n((?:\d+[.)]\s+.*\n?)+)/i, "").trim()
            : msg.text;
          return (
            <Box key={i} flexDirection="column">
              <Box>
                <Text bold color="green">Agent: </Text>
                <Text wrap="wrap">{cleanText.slice(0, 300)}</Text>
              </Box>
            </Box>
          );
        }
        if (msg.role === "tool") {
          return (
            <Box key={i}>
              <Text color="magenta">  Tool: </Text>
              <Text dimColor wrap="truncate">{msg.text.slice(0, 100)}</Text>
            </Box>
          );
        }
        return (
          <Box key={i}>
            <Text color="yellow">  {msg.text.slice(0, 120)}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled: boolean;
  placeholder?: string;
  autocompleteVisible: boolean;
  autocompleteIndex: number;
  autocompleteFiles: string[];
  inputBlocked?: boolean;
}

function ChatInput({
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder = "Type a message...",
  autocompleteVisible,
  autocompleteIndex,
  autocompleteFiles,
  inputBlocked,
}: ChatInputProps) {
  useInput((input, key) => {
    if (disabled || inputBlocked) return;

    if (autocompleteVisible && key.tab) {
      if (autocompleteFiles.length > 0) {
        const file = autocompleteFiles[autocompleteIndex % autocompleteFiles.length];
        const lastAtIndex = value.lastIndexOf("@");
        if (lastAtIndex >= 0) {
          onChange(value.slice(0, lastAtIndex + 1) + file + " ");
        }
      }
      return;
    }

    if (autocompleteVisible && key.upArrow) {
      return;
    }
    if (autocompleteVisible && key.downArrow) {
      return;
    }

    if (key.return) {
      onSubmit(value);
      return;
    }

    if (key.backspace || key.delete) {
      onChange(value.slice(0, -1));
      return;
    }

    if (key.escape && autocompleteVisible) {
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      onChange(value + input);
    }
  });

  return (
    <Box
      borderStyle="round"
      borderColor={disabled ? "gray" : "cyan"}
      paddingX={1}
    >
      <Text bold color={disabled ? "gray" : "cyan"}>{">"}</Text>
      <Text> </Text>
      {value.length === 0 && !disabled ? (
        <Text dimColor>{placeholder}</Text>
      ) : (
        <Text>{value}</Text>
      )}
      <Text backgroundColor="cyan" color="black"> </Text>
    </Box>
  );
}

interface QualityGateProps {
  report: StageReport;
  stageIndex: number;
  onApprove: () => void;
  onReject: (comment: string) => void;
  onRollback: () => void;
}

function QualityGate({
  report,
  stageIndex,
  onApprove,
  onReject,
  onRollback,
}: QualityGateProps) {
  const [mode, setMode] = useState<"review" | "reject">("review");
  const [comment, setComment] = useState("");
  const [actionIndex, setActionIndex] = useState(0);

  const actions: ArrowOption[] = [
    { label: "Approve — proceed to next stage", value: "approve" },
    { label: "Reject — send back with comment", value: "reject" },
    { label: "Rollback — revert to previous stage", value: "rollback" },
  ];

  useInput((input, key) => {
    if (mode === "review") {
      if (key.upArrow) setActionIndex(Math.max(0, actionIndex - 1));
      if (key.downArrow) setActionIndex(Math.min(actions.length - 1, actionIndex + 1));
      if (key.return) {
        const val = actions[actionIndex].value;
        if (val === "approve") onApprove();
        else if (val === "reject") setMode("reject");
        else if (val === "rollback") onRollback();
      }
    } else {
      if (key.return) {
        onReject(comment || "Rejected");
        setMode("review");
        setComment("");
      } else if (key.backspace || key.delete) {
        setComment(comment.slice(0, -1));
      } else if (key.escape) {
        setMode("review");
      } else if (input && !key.ctrl && !key.meta) {
        setComment(comment + input);
      }
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Box borderStyle="double" borderColor="yellow" paddingX={2} marginBottom={1}>
        <Text bold color="yellow">QUALITY GATE: {report.stageName}</Text>
      </Box>
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>Summary:</Text>
        <Text wrap="wrap">{report.summary}</Text>
      </Box>
      {report.issues.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="red">Issues:</Text>
          {report.issues.map((issue, i) => (
            <Text key={i}>  - {issue}</Text>
          ))}
        </Box>
      )}
      {mode === "review" ? (
        <Box borderStyle="single" borderColor="gray" paddingX={1}>
          <ArrowSelect
            options={actions}
            onSelect={(val) => {
              if (val === "approve") onApprove();
              else if (val === "reject") setMode("reject");
              else if (val === "rollback") onRollback();
            }}
            selectedIndex={actionIndex}
            onSelectedChange={setActionIndex}
          />
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text>Rejection comment:</Text>
          <Box borderStyle="single" borderColor="red" paddingX={1}>
            <Text>{comment}</Text>
            <Text backgroundColor="red"> </Text>
          </Box>
          <Text dimColor>[Enter] Submit | [Esc] Cancel</Text>
        </Box>
      )}
    </Box>
  );
}

interface MainViewProps {
  orchestrator: Orchestrator;
  flowName: string;
  onFlowComplete: () => void;
}

function MainView({ orchestrator, flowName, onFlowComplete }: MainViewProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const terminalHeight = stdout?.rows ?? 30;

  const [state, setState] = useState<FlowcodeState>(orchestrator.getState());
  const [messages, setMessages] = useState<
    Array<{ role: "user" | "agent" | "system" | "tool"; text: string; options?: string[] }>
  >([]);
  const [inputValue, setInputValue] = useState("");
  const [activeOptions, setActiveOptions] = useState<string[]>([]);
  const [optionsMode, setOptionsMode] = useState<"select" | "type" | "none">("none");
  const [optionIndex, setOptionIndex] = useState(0);
  const [waitingQualityGate, setWaitingQualityGate] = useState(false);
  const [qualityGateReport, setQualityGateReport] = useState<StageReport | null>(null);
  const [qualityGateStageIndex, setQualityGateStageIndex] = useState(0);
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelInfo, setModelInfo] = useState<string>("loading...");
  const [agentWorking, setAgentWorking] = useState(false);
  const [interactiveWaiting, setInteractiveWaiting] = useState(false);
  const [lastToolCall, setLastToolCall] = useState<string | null>(null);
  const [autocompleteVisible, setAutocompleteVisible] = useState(false);
  const [autocompleteQuery, setAutocompleteQuery] = useState("");
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);
  const [autocompleteFiles, setAutocompleteFiles] = useState<string[]>([]);

  useEffect(() => {
    const handlers: Array<[string, (...args: any[]) => void]> = [
      [
        "stage:start",
        (stageIndex: number, stage: StageConfig) => {
          setState(orchestrator.getState());
          setAgentWorking(true);
          setInteractiveWaiting(false);
          setMessages((prev) => [...prev, { role: "system", text: `Starting: ${stage.name}` }]);
        },
      ],
      [
        "stage:progress",
        (_si: number, message: string) => {
          setMessages((prev) => [...prev, { role: "system", text: message }]);
        },
      ],
      [
        "stage:complete",
        (_si: number, action: any) => {
          setAgentWorking(false);
          setLastToolCall(null);
          setMessages((prev) => [
            ...prev,
            { role: "system", text: `Stage done: ${action.action} — ${action.summary}` },
          ]);
        },
      ],
      [
        "stage:error",
        (_si: number, err: Error) => {
          setAgentWorking(false);
          setInteractiveWaiting(false);
          setMessages((prev) => [...prev, { role: "system", text: `Error: ${err.message}` }]);
        },
      ],
      [
        "stage:interactive",
        (waiting: boolean) => {
          setInteractiveWaiting(waiting);
          if (waiting) {
            setAgentWorking(false);
            setMessages((prev) => [...prev, { role: "system", text: "Waiting for your input..." }]);
          }
        },
      ],
      [
        "quality:gate",
        (stageIndex: number, report: StageReport) => {
          setAgentWorking(false);
          setWaitingQualityGate(true);
          setQualityGateReport(report);
          setQualityGateStageIndex(stageIndex);
        },
      ],
      [
        "agent:message",
        (message: string) => {
          setAgentWorking(false);
          const opts = parseAgentOptions(message);
          setMessages((prev) => [...prev, { role: "agent", text: message, options: opts.length > 0 ? opts : undefined }]);
          if (opts.length > 0) {
            setActiveOptions(opts);
            setOptionsMode("select");
            setOptionIndex(0);
          } else {
            setActiveOptions([]);
            setOptionsMode("none");
          }
        },
      ],
      [
        "agent:thinking",
        () => {
          setAgentWorking(true);
        },
      ],
      [
        "agent:tool-call",
        (tool: string, input?: string) => {
          setLastToolCall(tool);
          setMessages((prev) => [
            ...prev,
            { role: "tool", text: `${tool}(${input ?? ""})` },
          ]);
        },
      ],
      [
        "agent:tool-result",
        (_tool: string, output?: string) => {
          setLastToolCall(null);
        },
      ],
      [
        "flow:complete",
        () => {
          setAgentWorking(false);
          setCompleted(true);
          setMessages((prev) => [...prev, { role: "system", text: "Flow completed!" }]);
        },
      ],
      [
        "flow:error",
        (err: Error) => {
          setAgentWorking(false);
          setError(err.message);
        },
      ],
    ];

    for (const [event, handler] of handlers) {
      orchestrator.on(event, handler);
    }

    orchestrator.getModelInfo().then(setModelInfo).catch(() => setModelInfo("unknown"));

    orchestrator.start().catch((err: Error) => {
      setError(err.message);
    });

    return () => {
      for (const [event, handler] of handlers) {
        orchestrator.removeListener(event, handler);
      }
    };
  }, []);

  useEffect(() => {
    const lastAt = inputValue.lastIndexOf("@");
    if (lastAt >= 0) {
      const query = inputValue.slice(lastAt + 1);
      if (query.length === 0 || !query.includes(" ")) {
        setAutocompleteVisible(true);
        setAutocompleteQuery(query);
        const files = scanProjectFiles(query, 8);
        setAutocompleteFiles(files);
        setAutocompleteIndex(0);
        return;
      }
    }
    setAutocompleteVisible(false);
  }, [inputValue]);

  const handleSubmit = useCallback(
    (value: string) => {
      const msg = value.trim();
      if (!msg) return;
      setInputValue("");
      setActiveOptions([]);
      setOptionsMode("none");

      const atMatches = msg.match(/@(\S+)/g);
      const filePaths = atMatches
        ? atMatches.map((m) => m.slice(1)).filter((p) => {
            try { return existsSync(p); } catch { return false; }
          })
        : [];

      const cleanMsg = atMatches ? msg.replace(/@\S+/g, "").trim() || msg : msg;

      setMessages((prev) => [...prev, { role: "user", text: msg }]);
      setAgentWorking(true);

      if (cleanMsg.startsWith("/skip")) {
        setMessages((prev) => [...prev, { role: "system", text: "Skipping..." }]);
        setAgentWorking(false);
        return;
      }
      if (cleanMsg.startsWith("/pause")) {
        orchestrator.stop();
        return;
      }
      if (cleanMsg.startsWith("/quit")) {
        orchestrator.stop();
        exit();
        return;
      }

      if (filePaths.length > 0) {
        orchestrator.sendUserMessageWithContext(cleanMsg, filePaths).catch((err: Error) => {
          setMessages((prev) => [...prev, { role: "system", text: `Error: ${err.message}` }]);
          setAgentWorking(false);
        });
      } else {
        orchestrator.sendUserMessage(cleanMsg).catch((err: Error) => {
          setMessages((prev) => [...prev, { role: "system", text: `Error: ${err.message}` }]);
          setAgentWorking(false);
        });
      }
    },
    [orchestrator, exit]
  );

  const stages = orchestrator.getFlowStages();
  const currentState = orchestrator.getState();
  const spinner = useSpinner(agentWorking);
  const outputLines = Math.max(8, terminalHeight - 18);

  if (completed) {
    const reports = loadAllReports();
    const stages = orchestrator.getFlowStages();

    return (
      <Box flexDirection="column" padding={1}>
        <Box borderStyle="double" borderColor="green" paddingX={2} marginBottom={1}>
          <Text bold color="green">FLOW COMPLETED SUCCESSFULLY</Text>
        </Box>
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="cyan">Pipeline: {flowName}</Text>
          <Text dimColor>{stages.length} stages completed</Text>
        </Box>
        <Box flexDirection="column" marginBottom={1}>
          {reports.map((r, i) => (
            <Box key={r.stageId} marginBottom={i < reports.length - 1 ? 1 : 0}>
              <Text color="green">  ✓ </Text>
              <Text bold>{r.stageName}: </Text>
              <Text wrap="wrap">{r.summary?.slice(0, 120) || "Done"}</Text>
            </Box>
          ))}
        </Box>
        {reports.length > 0 && (() => {
          const allIssues = reports.flatMap(r => r.issues);
          if (allIssues.length > 0) return (
            <Box flexDirection="column" marginBottom={1}>
              <Text bold color="yellow">Issues:</Text>
              {allIssues.map((issue, i) => (
                <Text key={i} color="yellow">  - {issue.slice(0, 100)}</Text>
              ))}
            </Box>
          );
          return null;
        })()}
        <CompletedActions onRestart={onFlowComplete} onExit={exit} />
      </Box>
    );
  }

  if (error) {
    return (
      <Box padding={1}>
        <Text bold color="red">Error: {error}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="magenta">FLOWCODE</Text>
        <Text dimColor> | {flowName}</Text>
        <Text dimColor> | </Text>
        <Text color="green">{modelInfo}</Text>
        {agentWorking && (
          <Text color="yellow"> {spinner} Agent is working{lastToolCall ? ` (${lastToolCall})` : ""}...</Text>
        )}
      </Box>

      <Box flexDirection="row">
        <Box flexDirection="column" width={24}>
          <StageProgress
            stages={stages}
            currentIndex={currentState.currentStageIndex}
            stageActive={agentWorking}
          />
        </Box>

        <Box flexDirection="column" flexGrow={1}>
          {waitingQualityGate && qualityGateReport ? (
            <QualityGate
              report={qualityGateReport}
              stageIndex={qualityGateStageIndex}
              onApprove={() => {
                orchestrator.approveStage(qualityGateStageIndex);
                setWaitingQualityGate(false);
              }}
              onReject={(comment) => {
                orchestrator.rejectStage(qualityGateStageIndex, comment);
                setWaitingQualityGate(false);
              }}
              onRollback={() => {
                orchestrator.rejectStage(qualityGateStageIndex, "Rollback", true);
                setWaitingQualityGate(false);
              }}
            />
          ) : (
            <>
              <Box
                flexDirection="column"
                borderStyle="single"
                borderColor="gray"
                height={outputLines}
                overflowY="hidden"
              >
                <ChatOutput messages={messages} maxLines={outputLines - 2} />
              </Box>

              {autocompleteVisible && autocompleteFiles.length > 0 && (
                <FileAutocomplete
                  query={autocompleteQuery}
                  selectedIndex={autocompleteIndex}
                  onSelect={(path) => {
                    const lastAt = inputValue.lastIndexOf("@");
                    if (lastAt >= 0) {
                      setInputValue(inputValue.slice(0, lastAt + 1) + path + " ");
                    }
                  }}
                  visible={autocompleteVisible}
                />
              )}

              {optionsMode === "select" && activeOptions.length > 0 && (
                <InteractiveOptions
                  options={activeOptions}
                  selectedIndex={optionIndex}
                  onSelectedChange={setOptionIndex}
                  onSelect={(opt) => {
                    setActiveOptions([]);
                    setOptionsMode("none");
                    handleSubmit(opt);
                  }}
                  onTypeOwn={() => {
                    setOptionsMode("type");
                    setInputValue("");
                  }}
                />
              )}

              <ChatInput
                value={inputValue}
                onChange={setInputValue}
                onSubmit={handleSubmit}
                disabled={agentWorking && !interactiveWaiting && !waitingQualityGate}
                placeholder={
                  optionsMode === "type"
                    ? "Type your answer..."
                    : interactiveWaiting
                    ? "Type your message..."
                    : agentWorking
                    ? "Agent is working..."
                    : "Type a message... (@ for files)"
                }
                autocompleteVisible={autocompleteVisible}
                autocompleteIndex={autocompleteIndex}
                autocompleteFiles={autocompleteFiles}
                inputBlocked={optionsMode === "select"}
              />
            </>
          )}
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>/skip /pause /quit | @filename to attach files | Tab to autocomplete</Text>
      </Box>
    </Box>
  );
}

interface ResumePromptProps {
  state: FlowcodeState;
  onResume: () => void;
  onStartFresh: () => void;
}

function ResumePrompt({ state, onResume, onStartFresh }: ResumePromptProps) {
  const [selected, setSelected] = useState(0);

  const options: ArrowOption[] = [
    { label: "Resume — continue from where you left off", value: "resume" },
    { label: "Start fresh — discard previous progress", value: "fresh" },
  ];

  return (
    <Box flexDirection="column" padding={1}>
      <Box borderStyle="round" borderColor="yellow" paddingX={2} marginBottom={1}>
        <Text bold color="yellow">Found incomplete flow</Text>
      </Box>
      <Text>
        Flow: <Text bold>{state.currentFlow}</Text> | Stage: {state.currentStageIndex} | Status: {state.status}
      </Text>
      <Box marginTop={1}>
      <ArrowSelect
        options={options}
        onSelect={(val) => {
          if (val === "resume") onResume();
          else onStartFresh();
        }}
        selectedIndex={selected}
        onSelectedChange={setSelected}
      />
      </Box>
    </Box>
  );
}

interface ModelSelectorProps {
  current: ModelConfig | null;
  onSelect: (provider: string, model: string) => void;
  onSkip: () => void;
}

function ModelSelector({ current, onSelect, onSkip }: ModelSelectorProps) {
  const [models, setModels] = useState<ModelConfig[]>([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [scrollOffset, setScrollOffset] = useState(0);
  const { stdout } = useStdout();
  const visibleLines = Math.min(20, (stdout?.rows ?? 24) - 12);

  useEffect(() => {
    const mgr = new ServerManager();
    mgr.listModels().then((list) => {
      setModels(list);
      setLoading(false);
      if (current) {
        const idx = list.findIndex((m) => m.full === current.full);
        if (idx >= 0) setSelected(idx);
      }
    });
  }, []);

  const filtered = filter
    ? models.filter((m) => m.full.toLowerCase().includes(filter.toLowerCase()))
    : models;

  useEffect(() => {
    if (selected < scrollOffset) setScrollOffset(selected);
    if (selected >= scrollOffset + visibleLines) setScrollOffset(selected - visibleLines + 1);
  }, [selected, scrollOffset, visibleLines]);

  useInput((input, key) => {
    if (key.upArrow) {
      setSelected(Math.max(0, selected - 1));
    } else if (key.downArrow) {
      setSelected(Math.min(filtered.length - 1, selected + 1));
    } else if (key.return && filtered.length > 0) {
      const m = filtered[selected];
      onSelect(m.provider, m.model);
    } else if (key.escape) {
      onSkip();
    } else if (key.backspace || key.delete) {
      setFilter(filter.slice(0, -1));
      setSelected(0);
      setScrollOffset(0);
    } else if (input && !key.ctrl && !key.meta && !key.return) {
      const newFilter = filter + input;
      setFilter(newFilter);
      const newFiltered = models.filter((m) => m.full.toLowerCase().includes(newFilter.toLowerCase()));
      if (newFiltered.length > 0) {
        const currentFull = filtered[selected]?.full;
        const newIdx = currentFull ? newFiltered.findIndex((m) => m.full === currentFull) : 0;
        setSelected(newIdx >= 0 ? newIdx : 0);
      }
      setScrollOffset(0);
    }
  });

  if (loading) {
    return (
      <Box padding={1}>
        <Text bold color="magenta">FLOWCODE</Text>
        <Text> Loading models...</Text>
      </Box>
    );
  }

  const visibleModels = filtered.slice(scrollOffset, scrollOffset + visibleLines);
  let lastProvider = "";

  return (
    <Box flexDirection="column" padding={1}>
      <Box borderStyle="round" borderColor="magenta" paddingX={2} marginBottom={1}>
        <Text bold color="magenta">SELECT MODEL</Text>
      </Box>
      {current && (
        <Box marginBottom={1}>
          <Text dimColor>Current: </Text>
          <Text bold color="green">{current.full}</Text>
        </Box>
      )}
      <Box borderStyle="single" borderColor="cyan" paddingX={1} marginBottom={1}>
        <Text dimColor>Search: </Text>
        <Text bold color="cyan">{filter || "type to filter..."}</Text>
        <Text backgroundColor="cyan" color="black"> </Text>
      </Box>
      <Box flexDirection="column" marginBottom={1}>
        {visibleModels.map((m, i) => {
          const realIdx = scrollOffset + i;
          const isActive = realIdx === selected;
          const showProvider = m.provider !== lastProvider;
          lastProvider = m.provider;

          return (
            <Box key={m.full} flexDirection="column">
              {showProvider && i > 0 && <Text dimColor> </Text>}
              {showProvider && <Text bold color="yellow">  {m.provider}</Text>}
              <Text
                color={isActive ? "cyan" : undefined}
                bold={isActive}
                backgroundColor={isActive ? "gray" : undefined}
              >
                {isActive ? "  > " : "    "}{m.model}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box>
        <Text dimColor>
          {filtered.length} models | {scrollOffset + 1}-{Math.min(scrollOffset + visibleLines, filtered.length)} of {filtered.length}
        </Text>
      </Box>
      <Text dimColor>[↑↓] Navigate | [Enter] Select | [Esc] Use default | Type to search</Text>
    </Box>
  );
}

interface InteractiveOptionsProps {
  options: string[];
  selectedIndex: number;
  onSelectedChange: (idx: number) => void;
  onSelect: (value: string) => void;
  onTypeOwn: () => void;
}

function InteractiveOptions({ options, selectedIndex, onSelectedChange, onSelect, onTypeOwn }: InteractiveOptionsProps) {
  useInput((input, key) => {
    if (key.upArrow) onSelectedChange(Math.max(0, selectedIndex - 1));
    if (key.downArrow) onSelectedChange(Math.min(options.length, selectedIndex + 1));
    if (key.return) {
      if (selectedIndex < options.length) {
        onSelect(options[selectedIndex]);
      } else {
        onTypeOwn();
      }
    }
    if (input === "t" || input === "T") {
      onTypeOwn();
    }
  });

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1} marginBottom={1}>
      <Text bold color="yellow">Choose an option:</Text>
      {options.map((opt, i) => (
        <Text
          key={i}
          color={i === selectedIndex ? "cyan" : undefined}
          bold={i === selectedIndex}
          backgroundColor={i === selectedIndex ? "gray" : undefined}
        >
          {i === selectedIndex ? "  > " : "    "}{opt}
        </Text>
      ))}
      <Text
        color={selectedIndex === options.length ? "cyan" : "yellow"}
        bold={selectedIndex === options.length}
        backgroundColor={selectedIndex === options.length ? "gray" : undefined}
      >
        {selectedIndex === options.length ? "  > " : "    "}Type your own answer...
      </Text>
      <Text dimColor>[↑↓] Navigate | [Enter] Select | [T] Type own answer</Text>
    </Box>
  );
}

interface CompletedActionsProps {
  onRestart: () => void;
  onExit: () => void;
}

function CompletedActions({ onRestart, onExit }: CompletedActionsProps) {
  const [selected, setSelected] = useState(0);
  const options: ArrowOption[] = [
    { label: "Start new flow", value: "restart" },
    { label: "Exit", value: "exit" },
  ];

  useInput((input, key) => {
    if (key.upArrow) setSelected(Math.max(0, selected - 1));
    if (key.downArrow) setSelected(Math.min(options.length - 1, selected + 1));
    if (key.return) {
      const val = options[selected].value;
      if (val === "restart") onRestart();
      else onExit();
    }
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <ArrowSelect
        options={options}
        onSelect={(val) => {
          if (val === "restart") onRestart();
          else onExit();
        }}
        selectedIndex={selected}
        onSelectedChange={setSelected}
      />
    </Box>
  );
}

export default function App() {
  const { exit } = useApp();
  const [phase, setPhase] = useState<"init" | "select-flow" | "select-model" | "resume-prompt" | "running" | "completed">("init");
  const [config, setConfig] = useState<FlowcodeConfig | null>(null);
  const [selectedFlow, setSelectedFlow] = useState<string>("default");
  const [orchestrator, setOrchestrator] = useState<Orchestrator | null>(null);
  const [savedState, setSavedState] = useState<FlowcodeState | null>(null);
  const [modelConfig, setModelConfig] = useState<ModelConfig | null>(null);

  useEffect(() => {
    if (!configExists()) {
      initDefaultConfig();
    }
    const cfg = loadConfig();
    setConfig(cfg);

    const mgr = new ServerManager();
    mgr.loadCurrentModel();
    setModelConfig(mgr.getModel());

    const state = loadState();
    if (state && state.status !== "completed") {
      setSavedState(state);
      setPhase("resume-prompt");
    } else {
      setPhase("select-flow");
    }
  }, []);

  useInput((input) => {
    if (input === "q" && (phase === "init" || phase === "select-flow")) {
      exit();
    }
  });

  if (phase === "init" || !config) {
    return (
      <Box padding={1}>
        <Text bold color="magenta">FLOWCODE</Text>
        <Text> Loading...</Text>
      </Box>
    );
  }

  if (phase === "resume-prompt" && savedState) {
    return (
      <ResumePrompt
        state={savedState}
        onResume={() => {
          const orch = new Orchestrator(savedState.currentFlow);
          setOrchestrator(orch);
          setSelectedFlow(savedState.currentFlow);
          setPhase("running");
        }}
        onStartFresh={() => {
          resetFlowcodeDir();
          setPhase("select-flow");
        }}
      />
    );
  }

  if (phase === "select-flow") {
    return (
      <FlowSelector
        config={config}
        onSelect={(flowName) => {
          setSelectedFlow(flowName);
          setPhase("select-model");
        }}
      />
    );
  }

  if (phase === "select-model") {
    return (
      <ModelSelector
        current={modelConfig}
        onSelect={(provider, model) => {
          const mgr = new ServerManager();
          mgr.setModel(provider, model);
          setModelConfig({ provider, model, full: `${provider}/${model}` });
          const orch = new Orchestrator(selectedFlow);
          setOrchestrator(orch);
          setPhase("running");
        }}
        onSkip={() => {
          const orch = new Orchestrator(selectedFlow);
          setOrchestrator(orch);
          setPhase("running");
        }}
      />
    );
  }

  if (phase === "running" && orchestrator) {
    return (
      <MainView
        orchestrator={orchestrator}
        flowName={selectedFlow}
        onFlowComplete={() => {
          resetFlowcodeDir();
          setOrchestrator(null);
          setPhase("select-flow");
        }}
      />
    );
  }

  return null;
}

function existsSync(path: string): boolean {
  try {
    const { existsSync: ex } = require("node:fs");
    return ex(path);
  } catch {
    return false;
  }
}
