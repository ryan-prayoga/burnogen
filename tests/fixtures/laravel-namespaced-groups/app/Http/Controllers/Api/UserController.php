<?php

namespace App\Http\Controllers\Api;

use App\Enums\Api\UserRole;
use App\Http\Controllers\Controller;
use App\Http\Requests\Api\StoreUserRequest;
use App\Http\Resources\Api\UserResource;

class UserController extends Controller
{
    public function index()
    {
        return UserResource::collection([
            (object) [
                'id' => 1,
                'name' => 'API Jane',
                'email' => 'api@example.com',
                'role' => 'member',
            ],
        ]);
    }

    public function store(StoreUserRequest $request)
    {
        $request->enum('role', UserRole::class);

        return UserResource::make((object) [
            'id' => 2,
            'name' => 'API Owner',
            'email' => 'owner@example.com',
            'role' => 'owner',
        ])->additional([
            'meta' => [
                'source' => 'api',
            ],
        ]);
    }
}
