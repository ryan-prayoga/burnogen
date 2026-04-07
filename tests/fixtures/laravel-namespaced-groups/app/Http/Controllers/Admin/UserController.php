<?php

namespace App\Http\Controllers\Admin;

use App\Enums\Admin\UserRole;
use App\Http\Controllers\Controller;
use App\Http\Requests\Admin\StoreUserRequest;
use App\Http\Resources\Admin\UserResource;

class UserController extends Controller
{
    public function index()
    {
        return UserResource::collection([
            (object) [
                'id' => 99,
                'name' => 'Root Admin',
                'permissions' => ['manage-users'],
            ],
        ]);
    }

    public function store(StoreUserRequest $request)
    {
        $request->enum('role', UserRole::class);

        return new UserResource((object) [
            'id' => 100,
            'name' => 'Security Admin',
            'permissions' => ['manage-users', 'audit-logs'],
        ]);
    }
}
