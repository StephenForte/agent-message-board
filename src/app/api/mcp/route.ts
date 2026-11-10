import { handleMcpRequest } from '../../../mcp/handler';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = handleMcpRequest;
export const GET = handleMcpRequest;
export const DELETE = handleMcpRequest;
