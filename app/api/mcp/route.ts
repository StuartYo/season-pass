// MCP endpoint (spec 2025-11-25, Streamable HTTP). Also reachable at /mcp.
import { handleMcpRequest } from "@/mcp/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (req: Request) => handleMcpRequest(req);
export const GET = (req: Request) => handleMcpRequest(req);
export const DELETE = (req: Request) => handleMcpRequest(req);
export const OPTIONS = (req: Request) => handleMcpRequest(req);
