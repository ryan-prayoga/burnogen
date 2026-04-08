<?php

namespace App\Http\Controllers;

use App\Http\Requests\StoreUserRequest;

class UserController extends Controller
{
    public function index()
    {
        $page = request()->query('page');
        $token = request()->header('TTOKEN');

        return [
            'data' => [
                [
                    'id' => 1,
                    'name' => 'Jane Doe',
                ],
            ],
            'meta' => [
                'page' => $page ?? 1,
                'token' => $token,
            ],
        ];
    }

    public function store(StoreUserRequest $request)
    {
        return $this->createdResponse([
            'message' => 'User created',
            'data' => [
                'id' => 1,
                'name' => 'Jane Doe',
                'email' => 'jane@example.com',
            ],
        ]);
    }

    public function show(Request $request)
    {
        Project::query()->findOrFail(1);

        return ProjectResource::make((object) [
            'id' => 1,
            'name' => 'Launchpad',
            'owner_email' => 'owner@example.com',
        ])->additional([
            'meta' => [
                'trace_id' => 'trace_123',
            ],
        ]);
    }

    private function createdResponse(array $payload)
    {
        return response()->json($payload, 201);
    }
}
