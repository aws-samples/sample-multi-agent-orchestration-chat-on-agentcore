# Backend API Server

Express API server with JWT authentication support. Supports Amazon Cognito User Pool JWKS verification and is compatible with API Gateway + Lambda deployment.

## 📋 Table of Contents

- [Features](#-features)
- [API Endpoints](#-api-endpoints)
- [Setup](#-setup)
- [Development Environment](#-development-environment)

## 🚀 Features

- **JWT Authentication**: Amazon Cognito User Pool JWKS verification
- **Express API**: RESTful API server
- **CORS Support**: Frontend integration
- **TypeScript**: Type-safe implementation
- **Docker Support**: Containerized execution environment
- **Health Check**: API Gateway / Lambda compatible
- **Development Mode**: JWKS verification skip feature

## 🔌 API Endpoints

### Health Check (No Authentication Required)

```bash
GET /ping
```

**Response Example:**
```json
{
  "status": "healthy",
  "timestamp": "2025-12-19T10:42:00.000Z",
  "uptime": 123.456,
  "service": "agentcore-backend",
  "version": "0.1.0",
  "environment": "development",
  "cognito": {
    "configured": true,
    "userPoolId": "[CONFIGURED]"
  }
}
```

### Get User Information (Authentication Required)

```bash
GET /me
Authorization: Bearer <jwt_token>
```

**Response Example:**
```json
{
  "authenticated": true,
  "user": {
    "id": "12345678-1234-1234-1234-123456789012",
    "username": "john.doe",
    "email": "john.doe@example.com",
    "groups": ["users", "admins"]
  },
  "jwt": {
    "tokenUse": "access",
    "issuer": "https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_xxxxxxxxx",
    "audience": "your-client-id",
    "issuedAt": "2025-12-19T10:00:00.000Z",
    "expiresAt": "2025-12-19T11:00:00.000Z",
    "clientId": "your-client-id",
    "authTime": "2025-12-19T10:00:00.000Z"
  },
  "request": {
    "id": "req_1703057520123_abc123",
    "timestamp": "2025-12-19T10:42:00.000Z",
    "ip": "127.0.0.1",
    "userAgent": "Mozilla/5.0 ..."
  }
}
```

### API Information (No Authentication Required)

```bash
GET /
```

Returns API specifications and documentation information.

### Additional API Endpoints (Authentication Required)

The backend provides extensive API endpoints beyond the above. Key route groups:

| Route Group | Base Path | Description |
|-------------|-----------|-------------|
| Agents | `/agents` | CRUD for agent configurations, sharing, cloning |
| Sessions | `/sessions` | Session listing, event retrieval, deletion |
| Tools | `/tools` | Tool listing, search, health checks |
| Memory | `/memory` | Memory record listing, search, deletion |
| Storage | `/storage` | S3 file operations (upload, download, list, delete, tree) |
| Triggers | `/triggers` | CRUD for scheduled/event-driven triggers |
| Events | `/events` | Event source configuration |
| Webhooks | `/webhooks` | GitHub webhook integration |

See `packages/backend/src/routes/*.ts` for complete endpoint details.

## 🛠 Setup

### Install Dependencies

```bash
# From project root
npm install

# Or directly in backend directory
cd packages/backend
npm install
```

### Configure Environment Variables

```bash
# Copy .env.example to create .env
cp .env.example .env

# Edit .env file to set required environment variables
```

## 👨‍💻 Development Environment

### Start Development Server

```bash
# From root (recommended)
npm run dev:backend

# Or directly from backend directory
cd packages/backend
npm run dev
```

### Build

```bash
# TypeScript compilation
npm run build

# Start production server
npm start
```

### Available Scripts

```bash
npm run dev          # Development server (hot reload)
npm run build        # TypeScript build
npm run start        # Start production server
npm run clean        # Delete build artifacts
```


