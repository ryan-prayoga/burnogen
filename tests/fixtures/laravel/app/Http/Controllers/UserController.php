<?php

namespace App\Http\Controllers;

use App\Http\Requests\StoreUserRequest;
use App\Http\Resources\ProjectResource;
use Illuminate\Http\Request;

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
        return response()->json([
            'message' => 'User created',
            'data' => [
                'id' => 1,
                'name' => 'Jane Doe',
                'email' => 'jane@example.com',
            ],
        ], 201);
    }

    public function show(Request $request)
    {
        return new ProjectResource((object) [
            'id' => 1,
            'name' => 'Launchpad',
            'owner_email' => 'owner@example.com',
        ]);
    }
}
